/**
 * Cloud-split dispatcher (PR-4 placeholder).
 *
 * Cloud relays browser HTTP requests to this instance as `request` frames
 * carrying a `route` string + opaque `params` object. The dispatcher maps
 * each route to a pure async handler returning a `{ status, body }` pair
 * that the cloud-client serialises back into a `response` frame.
 *
 * PR-4 ships only the routing table and the wiring; the actual handler
 * bodies (transcript / sessions / hub aggregation) land once PR-2 has moved
 * the data sources into `@metabot/shared`. Until then every handler returns
 * HTTP 501 so the cloud relay can distinguish "not implemented yet" from
 * "instance offline".
 */

export interface DispatchResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (params: unknown) => Promise<DispatchResult>;

const notImplemented: RouteHandler = async (_params) => ({
  status: 501,
  body: { error: 'PR-2 pending: route not yet wired to shared core' },
});

export const routes: Record<string, RouteHandler> = {
  'transcript.get': notImplemented,
  'sessions.list': notImplemented,
  'hub.botList': notImplemented,
};

export async function dispatchRoute(
  route: string,
  params: unknown,
  table: Record<string, RouteHandler> = routes,
): Promise<DispatchResult> {
  const handler = table[route];
  if (!handler) {
    return { status: 404, body: { error: `unknown route: ${route}` } };
  }
  try {
    return await handler(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: 'handler threw', message } };
  }
}
