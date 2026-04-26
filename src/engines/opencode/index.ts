import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import { OpenCodeExecutor } from './executor.js';
import { OpenCodeStreamProcessor } from './stream-processor.js';

export class OpenCodeEngine implements Engine {
  readonly name = 'opencode' as const;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): Executor {
    return new OpenCodeExecutor(this.config, this.logger);
  }

  createStreamProcessor(userPrompt: string): OpenCodeStreamProcessor {
    return new OpenCodeStreamProcessor(userPrompt);
  }
}

export { OpenCodeExecutor } from './executor.js';
export { OpenCodeStreamProcessor } from './stream-processor.js';
export type { OpenCodeJsonEvent, OpenCodeTranslatorState } from './jsonl-translator.js';
export {
  createOpenCodeTranslatorState,
  translateOpenCodeJsonEvent,
} from './jsonl-translator.js';
