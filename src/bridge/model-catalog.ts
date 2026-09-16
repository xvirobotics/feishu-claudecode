import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude model catalog for `/model list`.
 *
 * The available set depends on the deployment's proxy: MetaBot talks to an
 * Anthropic-compatible endpoint whose `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,
 * FABLE}_MODEL` aliases point at whatever is actually routable (e.g. a
 * non-Anthropic model). A hardcoded Claude list is wrong in two ways — it
 * hides the real models and steers users onto names that the endpoint
 * rejects.
 *
 * Resolution order:
 *   1. explicit per-bot override (`bots.json` `availableModels`);
 *   2. the Claude Code settings file's `env` block
 *      (`CLAUDE_CONFIG_DIR/settings.json` or `$HOME/.claude/settings.json`);
 *   3. the bridge process environment;
 *   4. a curated default that excludes retired models.
 */
export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

/** Model names removed upstream; never advertise them. */
const RETIRED_MODELS = new Set(['claude-fable-5']);

/** `claude-fable-5[1m]` and `claude-fable-5` are the same upstream model. */
function baseModelId(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}

function isRetired(id: string): boolean {
  return RETIRED_MODELS.has(baseModelId(id));
}

const DEFAULT_CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'High-capability default · 200k context · append [1m] for 1M' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', note: '200k context · append [1m] for 1M' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', note: '200k context · append [1m] for 1M' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'Balanced · 200k context · append [1m] for 1M' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest · 200k context' },
];

const DEFAULT_MODEL_ENV_KEYS = [
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
  ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'],
  ['ANTHROPIC_MODEL', undefined],
  ['CLAUDE_MODEL', undefined],
] as const;

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fromEnvironment(environment: Readonly<Record<string, string | undefined>>): ModelOption[] {
  const models: ModelOption[] = [];
  for (const [idKey, nameKey] of DEFAULT_MODEL_ENV_KEYS) {
    const id = clean(environment[idKey]);
    if (!id) continue;
    const label = (nameKey ? clean(environment[nameKey]) : undefined) ?? id;
    models.push({ id, label, note: 'Available via the configured Anthropic-compatible endpoint' });
  }
  return models;
}

function readSettingsEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const configDir = clean(environment.CLAUDE_CONFIG_DIR)
    ?? (clean(environment.HOME) ? join(clean(environment.HOME) as string, '.claude') : undefined);
  if (!configDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      env?: Record<string, unknown>;
    };
    const env = parsed.env;
    if (!env || typeof env !== 'object') return {};
    const result: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function dedupe(models: readonly ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const model of models) {
    if (isRetired(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

export function claudeModelCatalog(options: {
  override?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}): ModelOption[] {
  const environment = options.env ?? {};
  const override = (options.override ?? [])
    .map((id) => clean(id))
    .filter((id): id is string => Boolean(id))
    .filter((id) => !isRetired(id));
  if (override.length > 0) {
    return dedupe(override.map((id) => ({ id, label: id })));
  }
  const configured = dedupe([
    ...fromEnvironment(readSettingsEnvironment(environment)),
    ...fromEnvironment(environment),
  ]);
  if (configured.length > 0) return configured;
  return dedupe(DEFAULT_CLAUDE_MODELS);
}
