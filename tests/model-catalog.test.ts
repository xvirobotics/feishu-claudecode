import { describe, it, expect } from 'vitest';
import { claudeModelCatalog } from '../src/bridge/model-catalog.js';

describe('claudeModelCatalog', () => {
  it('derives the list from ANTHROPIC_DEFAULT_*_MODEL aliases', () => {
    const models = claudeModelCatalog({
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Kimi K3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      },
    });
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(['kimi-k3', 'glm-5.3']);
    expect(models[0].label).toBe('Kimi K3');
  });

  it('never advertises a retired model even if the endpoint still aliases it', () => {
    const models = claudeModelCatalog({
      env: {
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
      },
    });
    expect(models.map((m) => m.id)).not.toContain('claude-fable-5');
    expect(models.map((m) => m.id)).toContain('claude-opus-4-8');
  });

  it('treats the [1m] variant of a retired model as retired too', () => {
    const models = claudeModelCatalog({
      env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5[1M]' },
      override: ['claude-fable-5[1m]'],
    });
    expect(models.map((m) => m.id)).not.toContain('claude-fable-5[1M]');
  });

  it('per-bot override wins and is deduped', () => {
    const models = claudeModelCatalog({
      override: ['glm-5.3', 'glm-5.3', ' kimi-k3 '],
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'should-not-appear' },
    });
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k3']);
  });

  it('filters retired models out of an explicit override', () => {
    const models = claudeModelCatalog({ override: ['claude-fable-5', 'glm-5.3'] });
    expect(models.map((m) => m.id)).toEqual(['glm-5.3']);
  });

  it('falls back to a curated default that excludes retired models when nothing is configured', () => {
    const models = claudeModelCatalog({ env: {} });
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).not.toContain('claude-fable-5');
  });
});
