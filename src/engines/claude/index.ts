import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import { ClaudeExecutor } from './executor.js';
import { StreamProcessor } from './stream-processor.js';

export class ClaudeEngine implements Engine {
  readonly name = 'claude' as const;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): Executor {
    return new ClaudeExecutor(this.config, this.logger);
  }

  createStreamProcessor(userPrompt: string): StreamProcessor {
    return new StreamProcessor(userPrompt);
  }
}

export { ClaudeExecutor } from './executor.js';
export { StreamProcessor, extractImagePaths } from './stream-processor.js';
export { SessionManager } from './session-manager.js';
export type { UserSession } from './session-manager.js';
export type {
  SDKMessage,
  ExecutionHandle,
  ExecutorOptions,
  ApiContext,
} from './executor.js';
export type { DetectedTool } from './stream-processor.js';
