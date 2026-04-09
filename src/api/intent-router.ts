import type { Logger } from '../utils/logger.js';
import type { BotInfo } from './bot-registry.js';

export type RouterMode = 'auto' | 'suggest' | 'manual';

export interface RouteResult {
  targetBot: string;
  confidence: number;
  reasoning: string;
  mode: RouterMode;
}

/**
 * Lightweight intent router that classifies which bot should handle a request.
 * Uses keyword-based matching on bot descriptions and names.
 *
 * Modes:
 * - manual: always use the current/default bot (no routing)
 * - suggest: score bots and return suggestion, caller decides
 * - auto: score bots and return the best match
 */
export class IntentRouter {
  private logger: Logger;
  private mode: RouterMode;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'intent-router' });
    this.mode = (process.env.INTENT_ROUTER_MODE as RouterMode) || 'manual';
  }

  getMode(): RouterMode {
    return this.mode;
  }

  setMode(mode: RouterMode): void {
    this.mode = mode;
  }

  /**
   * Route a message to the best bot based on content analysis.
   * Uses keyword matching against bot names, descriptions, and specialties.
   */
  async route(
    message: string,
    availableBots: BotInfo[],
    currentBot?: string,
  ): Promise<RouteResult> {
    if (this.mode === 'manual' || availableBots.length <= 1) {
      return {
        targetBot: currentBot || availableBots[0]?.name || '',
        confidence: 1,
        reasoning: 'Manual mode or single bot',
        mode: this.mode,
      };
    }

    // Score each bot by keyword matching against their description, name, and specialties
    const msgLower = message.toLowerCase();
    let bestBot = currentBot || availableBots[0]?.name || '';
    let bestScore = 0;
    let bestReasoning = 'Default bot';

    for (const bot of availableBots) {
      const desc = (bot.description || '').toLowerCase();
      const name = bot.name.toLowerCase();
      const specialties = (bot.specialties || []).map((s) => s.toLowerCase());
      let score = 0;
      const matches: string[] = [];

      // Split description into keywords and check message for matches
      const keywords = [
        ...desc.split(/[\s,./\-_]+/).filter((w) => w.length > 2),
        ...name.split(/[\s\-_]+/).filter((w) => w.length > 2),
      ];
      for (const kw of keywords) {
        if (msgLower.includes(kw)) {
          score += 1;
          matches.push(kw);
        }
      }

      // Specialties get higher weight
      for (const specialty of specialties) {
        if (msgLower.includes(specialty)) {
          score += 3;
          matches.push(`specialty:${specialty}`);
        }
      }

      // Exact bot name mention gets high score
      if (msgLower.includes(name)) {
        score += 10;
        matches.push(`name:${name}`);
      }

      if (score > bestScore) {
        bestScore = score;
        bestBot = bot.name;
        bestReasoning = `Matched keywords: ${matches.join(', ')}`;
      }
    }

    const result: RouteResult = {
      targetBot: bestBot,
      confidence: bestScore > 0 ? Math.min(bestScore / 5, 1) : 0.3,
      reasoning: bestScore > 0 ? bestReasoning : 'No keyword match, using default',
      mode: this.mode,
    };

    this.logger.info(
      { message: message.slice(0, 100), targetBot: result.targetBot, confidence: result.confidence },
      'Intent routed',
    );
    return result;
  }
}
