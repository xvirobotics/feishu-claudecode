import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Engine, EngineName } from './types.js';
import { ClaudeEngine } from './claude/index.js';
import { KimiEngine } from './kimi/index.js';
import { CodexEngine } from './codex/index.js';

/**
 * Create an Engine for the given bot config.
 *
 * Engine selection:
 *   1. `config.engine` field (explicit)
 *   2. `METABOT_ENGINE` env var (global default)
 *   3. `'claude'` (fallback)
 */
export function createEngine(
  config: BotConfigBase,
  logger: Logger,
  override?: EngineName,
): Engine {
  const name = override ?? resolveEngineName(config);
  switch (name) {
    case 'claude':
      return new ClaudeEngine(config, logger);
    case 'kimi':
      return new KimiEngine(config, logger);
    case 'codex':
      return new CodexEngine(config, logger);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown engine: ${_exhaustive}`);
    }
  }
}

/** Resolve the default engine for a bot config (no session override). */
export function resolveEngineName(config: BotConfigBase): EngineName {
  const explicit = config.engine;
  if (explicit) return explicit;
  const envDefault = process.env.METABOT_ENGINE as EngineName | undefined;
  if (envDefault === 'claude' || envDefault === 'kimi' || envDefault === 'codex') return envDefault;
  return 'claude';
}

export type { Engine, EngineName, Executor } from './types.js';
export { ClaudeEngine } from './claude/index.js';
export { KimiEngine } from './kimi/index.js';
export { CodexEngine } from './codex/index.js';

// Re-export shared types and classes currently used by the bridge and web/api layers.
// Moving these behind the engine boundary lets consumers import from a single place.
export {
  ClaudeExecutor,
  StreamProcessor,
  SessionManager,
  extractImagePaths,
} from './claude/index.js';
export type {
  UserSession,
  SDKMessage,
  ExecutionHandle,
  ExecutorOptions,
  ApiContext,
  DetectedTool,
} from './claude/index.js';
