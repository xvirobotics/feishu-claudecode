import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleManifestRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET' || url !== '/api/manifest') return false;

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
    },
    memory: {
      namespace: instance.memoryNamespace,
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
