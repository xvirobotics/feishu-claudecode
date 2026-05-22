/* ============================================================
   manager/ManagerApp.tsx — top-level container.

   - Mounts auth check via GET /api/manager/auth/me on mount.
   - If 401, redirect to /manager/login (preserving ?next).
   - On success, renders nested routes via React Router.
   - Provides ToastProvider for all child screens.
============================================================ */

import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { authLogout, authMe, ApiError } from './api';
import { LoginPage } from './LoginPage';
import { Dashboard } from './Dashboard';
import { BotDetail } from './BotDetail';
import { ToastProvider, useBodyScroll, useToast } from './toast';
import styles from './manager.module.css';

type AuthState =
  | { kind: 'checking' }
  | { kind: 'anon' }
  | { kind: 'authed'; username: string };

export function ManagerApp() {
  useBodyScroll();
  return (
    <ToastProvider>
      <ManagerInner />
    </ToastProvider>
  );
}

function ManagerInner() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' });
  const navigate        = useNavigate();
  const location        = useLocation();

  // Run auth probe on mount AND whenever route changes to /manager/login → recheck
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authMe();
        if (cancelled) return;
        setAuth({ kind: 'authed', username: res.username });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setAuth({ kind: 'anon' });
        } else {
          // Network or 5xx — treat as anon so user can retry login
          setAuth({ kind: 'anon' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bubble-up auth-lost from child screens.
  const onAuthLost = useCallback(() => {
    setAuth({ kind: 'anon' });
    const dest = location.pathname + location.search;
    const next = encodeURIComponent(`/web${dest}`);
    navigate(`/manager/login?next=${next}`, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const onAuthed = useCallback((username: string) => {
    setAuth({ kind: 'authed', username });
  }, []);

  if (auth.kind === 'checking') {
    return (
      <div className={styles.page}>
        <div className={styles.statusBlock}>正在校验登录态…</div>
      </div>
    );
  }

  // Anonymous: only allow /login; other paths redirect there
  if (auth.kind === 'anon') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onAuthed={onAuthed} />} />
        <Route
          path="*"
          element={
            <Navigate
              to={`/manager/login?next=${encodeURIComponent(`/web${location.pathname}${location.search}`)}`}
              replace
            />
          }
        />
      </Routes>
    );
  }

  // Authed
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/manager/dashboard" replace />} />
      <Route
        path="/"
        element={<Navigate to="/manager/dashboard" replace />}
      />
      <Route
        path="/dashboard"
        element={
          <ManagerShell username={auth.username} onLoggedOut={() => setAuth({ kind: 'anon' })}>
            <Dashboard onAuthLost={onAuthLost} />
          </ManagerShell>
        }
      />
      <Route
        path="/bots/:name"
        element={
          <ManagerShell username={auth.username} onLoggedOut={() => setAuth({ kind: 'anon' })}>
            <BotDetail onAuthLost={onAuthLost} />
          </ManagerShell>
        }
      />
      <Route
        path="*"
        element={<Navigate to="/manager/dashboard" replace />}
      />
    </Routes>
  );
}

interface ManagerShellProps {
  username:     string;
  onLoggedOut:  () => void;
  children:     React.ReactNode;
}

function ManagerShell({ username, onLoggedOut, children }: ManagerShellProps) {
  const toast    = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      await authLogout();
    } catch (err) {
      // best-effort; still flip to anon
      toast.show(err instanceof Error ? err.message : '登出请求失败', 'error');
    } finally {
      setBusy(false);
      onLoggedOut();
      navigate('/manager/login', { replace: true });
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <span className={styles.topBarTitle}>
          MetaBot <span className={styles.topBarTitleAccent}>Manager</span>
        </span>
        <div className={styles.topBarSpacer} />
        <span className={styles.topBarUser}>👤 {username}</span>
        <button
          type="button"
          className={styles.topBarBtn}
          onClick={handleLogout}
          disabled={busy}
        >
          {busy ? '登出中…' : '登出'}
        </button>
      </header>
      {children}
    </div>
  );
}
