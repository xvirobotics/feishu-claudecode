/**
 * Path helpers for the transcript SPA.
 *
 * The SPA is mounted at two locations:
 *
 *   - local manager UI: `/web/transcript/:chatId`
 *   - cloud relay:      `/i/<instanceId>/web/transcript/:chatId`
 *
 * Vite emits assets with `base: './'` so HTML-relative asset loading works at
 * both mount points without a hardcoded prefix. The runtime still needs to
 * build absolute API URLs (`fetch('/api/transcript/...')`) and to seed the
 * react-router `basename`, both of which depend on which mount we're on.
 */

const TRANSCRIPT_PATH_RE = /\/web\/transcript\/.*$/;

/**
 * Derive the API base prefix from `window.location.pathname`.
 *
 * Returns `''` for the local mount (so callers can prepend it to
 * `/api/transcript/...` and get the original path) and `/i/<instanceId>` for
 * the cloud mount. If the pathname doesn't look like a transcript route at
 * all (defensive), returns `''`.
 */
export function deriveApiBase(pathname: string): string {
  if (typeof pathname !== 'string') return '';
  const stripped = pathname.replace(TRANSCRIPT_PATH_RE, '');
  // Local case: pathname was `/web/transcript/...`, stripped is `''`.
  // Cloud case: pathname was `/i/<id>/web/transcript/...`, stripped is `/i/<id>`.
  // Defensive: pathname didn't match → stripped === pathname; treat as local.
  if (stripped === pathname) return '';
  return stripped;
}

/**
 * Derive the react-router `basename` from `window.location.pathname`.
 *
 * Returns `/web` for the local mount (matches the current hardcoded value)
 * and `/i/<instanceId>/web` for the cloud mount.
 */
export function deriveRouterBasename(pathname: string): string {
  return `${deriveApiBase(pathname)}/web`;
}
