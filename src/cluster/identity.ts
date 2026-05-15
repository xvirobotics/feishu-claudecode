import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type DiscoveryMode = 'auto' | 'static' | 'standalone' | 'off';

export interface InstanceIdentity {
  instanceId: string;
  instanceName: string;
  clusterId?: string;
  clusterUrl?: string;
  discoveryMode: DiscoveryMode;
  memoryNamespace: string;
  identityPath: string;
  publicKey?: string;
}

interface PersistedIdentity {
  instanceId: string;
  instanceName?: string;
  publicKey?: string;
  privateKeyPath?: string;
  createdAt?: string;
}

export interface LoadIdentityOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function expandUserPath(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function sanitizeId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return sanitized || 'metabot';
}

function defaultInstanceName(): string {
  const user = os.userInfo().username || 'user';
  const host = os.hostname() || 'host';
  return `${user}@${host}`;
}

function generateInstanceId(instanceName: string): string {
  return `${sanitizeId(instanceName)}-${crypto.randomBytes(3).toString('hex')}`;
}

function readPersistedIdentity(identityPath: string): PersistedIdentity | undefined {
  try {
    const raw = fs.readFileSync(identityPath, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedIdentity;
    if (parsed && typeof parsed.instanceId === 'string' && parsed.instanceId.trim()) {
      return parsed;
    }
  } catch {
    // Missing or invalid identity files are handled by creating a new identity.
  }
  return undefined;
}

function ensurePersistedIdentity(identityPath: string, instanceName: string): PersistedIdentity {
  const existing = readPersistedIdentity(identityPath);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  const keyPath = path.join(path.dirname(identityPath), 'identity.key');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  fs.writeFileSync(keyPath, privatePem, { mode: 0o600 });

  const identity: PersistedIdentity = {
    instanceId: generateInstanceId(instanceName),
    instanceName,
    publicKey: publicPem,
    privateKeyPath: keyPath,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

function parseDiscoveryMode(value: string | undefined): DiscoveryMode {
  if (value === 'static' || value === 'standalone' || value === 'off') return value;
  return 'auto';
}

export function loadInstanceIdentity(options: LoadIdentityOptions = {}): InstanceIdentity {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const metabotHome = expandUserPath(env.METABOT_HOME || '~/.metabot', homeDir);
  const identityPath = expandUserPath(
    env.METABOT_IDENTITY_PATH || path.join(metabotHome, 'identity.json'),
    homeDir,
  );

  const requestedName = env.METABOT_INSTANCE_NAME || defaultInstanceName();
  const persisted = ensurePersistedIdentity(identityPath, requestedName);
  const instanceName = env.METABOT_INSTANCE_NAME || persisted.instanceName || requestedName;
  const instanceId = env.METABOT_INSTANCE_ID || persisted.instanceId;
  const memoryNamespace = env.METABOT_MEMORY_NAMESPACE || `/instances/${instanceId}`;

  return {
    instanceId,
    instanceName,
    clusterId: env.METABOT_CLUSTER_ID || undefined,
    clusterUrl: env.METABOT_CLUSTER_URL || undefined,
    discoveryMode: parseDiscoveryMode(env.METABOT_DISCOVERY_MODE),
    memoryNamespace,
    identityPath,
    publicKey: persisted.publicKey,
  };
}
