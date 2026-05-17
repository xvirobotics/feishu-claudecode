import type { CredentialsStore } from '../auth/credentials-store.js';
import type { Credential, IssueInput, Role } from '../auth/credentials.js';
import type { AuditLog } from '../observability/audit-log.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function adminOnly(cred: Credential): RouteResult | null {
  if (cred.role !== 'admin') return err(403, 'admin_required');
  return null;
}

export function issueCredential(
  store: CredentialsStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;

  const botName = (body.botName as string) || '';
  const ownerName = (body.ownerName as string) || '';
  const role = (body.role as Role) || 'member';
  if (!botName) return err(400, 'botName_required');
  if (!ownerName) return err(400, 'ownerName_required');
  if (role !== 'admin' && role !== 'member') return err(400, 'invalid_role');

  const input: IssueInput = {
    botName,
    ownerName,
    role,
    writableNamespaces: Array.isArray(body.writableNamespaces)
      ? (body.writableNamespaces as string[]) : undefined,
    readableNamespaces: Array.isArray(body.readableNamespaces)
      ? (body.readableNamespaces as string[]) : undefined,
    publishSkill: typeof body.publishSkill === 'boolean' ? (body.publishSkill as boolean) : undefined,
    notes: typeof body.notes === 'string' ? (body.notes as string) : undefined,
  };

  const result = store.issue(input);
  return { status: 201, body: result };
}

export function revokeCredential(
  store: CredentialsStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;

  const credentialId = body.credentialId as string | undefined;
  if (!credentialId) return err(400, 'credentialId_required');
  const revokedAt = store.revoke(credentialId);
  if (revokedAt === null) return err(404, 'credential_not_found');
  return { status: 200, body: { ok: true, revokedAt } };
}

export function listCredentials(store: CredentialsStore, cred: Credential): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  return { status: 200, body: { credentials: store.list() } };
}

export function readAudit(
  audit: AuditLog,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const date = query.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err(400, 'date_required_YYYY-MM-DD');
  }
  const principal = query.get('principal') || undefined;
  const op = query.get('op') || undefined;
  const entries = audit.read(date, { principalId: principal, op });
  return { status: 200, body: { entries } };
}
