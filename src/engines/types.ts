import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type {
  ClaudeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
} from './claude/executor.js';
import type { CodexExecutor } from './codex/executor.js';
import type { OpenCodeExecutor } from './opencode/executor.js';
import type { StreamProcessor } from './claude/stream-processor.js';
import type { OpenCodeStreamProcessor } from './opencode/stream-processor.js';

export type EngineName = 'claude' | 'kimi' | 'codex' | 'opencode';

/**
 * An Engine is a programmable agent backend (Claude Code, Kimi Code, …).
 * It produces an Executor that the bridge drives for a single chat session.
 *
 * In Phase 1 we only ship the Claude implementation; the interface lets us
 * drop in a Kimi implementation without touching the bridge.
 */
export interface Engine {
  readonly name: EngineName;
  /** Returns the executor used to run queries for this engine. */
  createExecutor(): Executor;
  /** Returns the StreamProcessor class used to process engine messages into CardState. */
  createStreamProcessor(userPrompt: string): StreamProcessorLike;
}

/**
 * Executor abstraction. Both engines must support the multi-turn
 * `startExecution` path (streaming + sendAnswer + resolveQuestion + finish)
 * and the one-shot `execute` path used by voice mode.
 *
 * Phase 1 aliases these to the Claude types. Phase 2 will generalise
 * SDKMessage into a union (EngineMessage) with Kimi-specific events.
 */
export interface Executor {
  startExecution(options: ExecutorOptions): ExecutionHandle;
  execute(options: ExecutorOptions): AsyncGenerator<SDKMessage>;
}

export type StreamProcessorLike = StreamProcessor | OpenCodeStreamProcessor;

export type {
  ClaudeExecutor,
  CodexExecutor,
  OpenCodeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
};

/** Context passed to engine factory. */
export interface EngineContext {
  config: BotConfigBase;
  logger: Logger;
}
