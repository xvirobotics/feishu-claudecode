/**
 * HTTP fetch utility with proxy + NO_PROXY support.
 *
 * Node.js native fetch() does not automatically respect HTTP_PROXY / HTTPS_PROXY
 * environment variables. This module provides:
 *   - proxyFetch()        — drop-in fetch() replacement with proxy + NO_PROXY
 *   - shouldBypassProxy() — reusable check for Telegram/grammy code that uses HttpsProxyAgent
 */

import { ProxyAgent, Agent } from 'undici';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function getNoProxyPatterns(): string[] {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY env var.
 *
 * Supports: exact hostname, `.example.com` suffix, `*.example.com` wildcard, `*` match-all.
 */
export function shouldBypassProxy(urlOrString: string | URL): boolean {
  const patterns = getNoProxyPatterns();
  if (patterns.length === 0) return false;
  if (patterns.includes('*')) return true;

  let hostname: string;
  try {
    hostname = (typeof urlOrString === 'string' ? new URL(urlOrString) : urlOrString).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const pattern of patterns) {
    if (pattern === hostname) return true;
    const suffix = pattern.startsWith('*.') ? pattern.slice(1) : pattern.startsWith('.') ? pattern : null;
    if (suffix && (hostname === suffix.slice(1) || hostname.endsWith(suffix))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cached dispatchers
// ---------------------------------------------------------------------------

let _proxyAgent: ProxyAgent | undefined;
let _directAgent: Agent | undefined;

function getProxyAgent(proxyUrl: string): ProxyAgent {
  if (!_proxyAgent) {
    _proxyAgent = new ProxyAgent(proxyUrl);
  }
  return _proxyAgent;
}

function getDirectAgent(): Agent {
  if (!_directAgent) {
    _directAgent = new Agent();
  }
  return _directAgent;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for fetch() that honours HTTP_PROXY/HTTPS_PROXY and NO_PROXY.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const proxyUrl = getProxyUrl();

  if (!proxyUrl) {
    return fetch(url, init);
  }

  if (shouldBypassProxy(url)) {
    return fetch(url, { ...init, dispatcher: getDirectAgent() } as RequestInit);
  }

  return fetch(url, { ...init, dispatcher: getProxyAgent(proxyUrl) } as RequestInit);
}
