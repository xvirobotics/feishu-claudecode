import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import { StreamProcessor } from '../claude/stream-processor.js';

/**
 * Kimi engine placeholder. The real implementation lands in Phase 2,
 * wrapping `@moonshot-ai/kimi-agent-sdk`. Constructing this engine today
 * throws at executor-creation time so multi-bot configs that declare
 * `"engine": "kimi"` fail loudly instead of silently falling back to Claude.
 */
export class KimiEngine implements Engine {
  readonly name = 'kimi' as const;

  constructor(
    _config: BotConfigBase,
    _logger: Logger,
  ) {}

  createExecutor(): Executor {
    throw new Error(
      'Kimi engine not yet implemented (Phase 2). ' +
      'Remove `engine: "kimi"` from this bot or switch to `engine: "claude"` for now.'
    );
  }

  createStreamProcessor(userPrompt: string): StreamProcessor {
    // Reuse Claude StreamProcessor for type compatibility until Phase 2.
    return new StreamProcessor(userPrompt);
  }
}
