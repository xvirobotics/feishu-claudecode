/**
 * Auth routes: registration, login, user management.
 * POST /api/auth/register — self-service registration
 * POST /api/auth/login    — login with username + password
 * GET  /api/auth/me       — get current user info (requires token)
 * GET  /api/users          — list users (public info)
 * DELETE /api/users/:id    — delete user (admin only)
 */
import type { RouteHandler } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { UserStore } from '../../auth/user-store.js';

export function createAuthRoutes(userStore: UserStore): RouteHandler {
  return async (ctx, req, res, method, url) => {
    // ── Public endpoints (no auth required) ──

    if (method === 'POST' && url === '/api/auth/register') {
      const body = await parseJsonBody(req);
      const { username, password, displayName } = body as {
        username?: string;
        password?: string;
        displayName?: string;
      };

      if (!username || !password) {
        jsonResponse(res, 400, { error: 'username and password are required' });
        return true;
      }

      if (username.length < 2 || username.length > 32) {
        jsonResponse(res, 400, { error: 'Username must be 2-32 characters' });
        return true;
      }

      if (password.length < 4) {
        jsonResponse(res, 400, { error: 'Password must be at least 4 characters' });
        return true;
      }

      try {
        // First user gets admin role
        const role = userStore.count() === 0 ? 'admin' : 'user';
        const user = userStore.register(username, password, displayName as string | undefined, role);
        jsonResponse(res, 201, {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          avatarColor: user.avatarColor,
          token: user.token,
        });
      } catch (err: any) {
        jsonResponse(res, 409, { error: err.message });
      }
      return true;
    }

    if (method === 'POST' && url === '/api/auth/login') {
      const body = await parseJsonBody(req);
      const { username, password } = body as { username?: string; password?: string };

      if (!username || !password) {
        jsonResponse(res, 400, { error: 'username and password are required' });
        return true;
      }

      const user = userStore.login(username, password);
      if (!user) {
        jsonResponse(res, 401, { error: 'Invalid username or password' });
        return true;
      }

      jsonResponse(res, 200, {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        avatarColor: user.avatarColor,
        token: user.token,
      });
      return true;
    }

    // ── Authenticated endpoints ──

    if (method === 'GET' && url === '/api/auth/me') {
      // Requires valid token
      const token = extractToken(req);
      if (!token) {
        jsonResponse(res, 401, { error: 'Token required' });
        return true;
      }
      const user = userStore.validateToken(token);
      if (!user) {
        jsonResponse(res, 401, { error: 'Invalid token' });
        return true;
      }
      jsonResponse(res, 200, {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        avatarColor: user.avatarColor,
      });
      return true;
    }

    if (method === 'GET' && url === '/api/users') {
      const users = userStore.listUsers();
      jsonResponse(res, 200, { users });
      return true;
    }

    if (method === 'DELETE' && url.startsWith('/api/users/')) {
      const userId = url.slice('/api/users/'.length);
      if (!userId) {
        jsonResponse(res, 400, { error: 'User ID required' });
        return true;
      }
      // Check admin permission
      const token = extractToken(req);
      if (!token) {
        jsonResponse(res, 401, { error: 'Token required' });
        return true;
      }
      const currentUser = userStore.validateToken(token);
      if (!currentUser || currentUser.role !== 'admin') {
        jsonResponse(res, 403, { error: 'Admin access required' });
        return true;
      }
      const deleted = userStore.deleteUser(userId);
      jsonResponse(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'User not found' });
      return true;
    }

    return false;
  };
}

function extractToken(req: import('node:http').IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token');
}
