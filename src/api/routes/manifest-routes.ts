import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleManifestRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method === 'GET' && url === '/api/manifest') {
    const { instance, registry, peerManager, memoryServerUrl, skillHubStore } = ctx;
    jsonResponse(res, 200, {
      schemaVersion: 1,
      instance: {
        id: instance.instanceId,
        name: instance.instanceName,
        clusterId: instance.clusterId,
        discoveryMode: instance.discoveryMode,
        publicKey: instance.publicKey,
      },
      capabilities: {
        bots: true,
        skills: !!skillHubStore,
        memory: !!memoryServerUrl,
        peers: !!peerManager,
      },
      endpoints: {
        bots: '/api/bots',
        skills: '/api/skills',
        skillsSearch: '/api/skills/search?q=',
        memory: memoryServerUrl,
        peers: '/api/peers',
        peerHandshake: '/api/peer-handshake',
      },
      memory: {
        namespace: instance.memoryNamespace,
        writableNamespaces: process.env.METABOT_MEMORY_NAMESPACES
          ? process.env.METABOT_MEMORY_NAMESPACES.split(',').filter(Boolean)
          : [instance.memoryNamespace],
        mode: 'namespace-readwrite',
      },
      stats: {
        localBots: registry.list().length,
        peerBots: peerManager?.getPeerBots().length ?? 0,
        localSkills: skillHubStore?.list().length ?? 0,
        peerSkills: peerManager?.getPeerSkills().length ?? 0,
      },
    });
    return true;
  }

  if (method === 'POST' && url === '/api/peer-handshake') {
    const { peerManager, logger } = ctx;
    if (!peerManager) {
      jsonResponse(res, 503, { error: 'Peer manager not enabled' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId : '';
    const readerToken = typeof body.readerToken === 'string' ? body.readerToken : '';
    const instanceName = typeof body.instanceName === 'string' ? body.instanceName : undefined;
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : undefined;
    if (!instanceId || !readerToken) {
      jsonResponse(res, 400, { error: 'instanceId and readerToken are required' });
      return true;
    }
    const reply = peerManager.registerInboundHandshake({
      instanceId,
      readerToken,
      ...(instanceName ? { instanceName } : {}),
      ...(publicKey ? { publicKey } : {}),
    });
    if (!reply) {
      jsonResponse(res, 409, { error: 'Handshake refused' });
      return true;
    }
    logger.info({ peerInstance: instanceId }, 'Inbound peer handshake recorded');
    jsonResponse(res, 200, reply);
    return true;
  }

  return false;
}
