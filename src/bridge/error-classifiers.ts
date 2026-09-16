export function isStaleSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /no conversation found|conversation not found|session id|invalid session|thread\/resume.*failed|no rollout found|multiple.*tool_result.*blocks|each tool_use must have a single result/i.test(errorMessage);
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /context.window.exceeds.limit|context.length.exceeded|context.too.long|max.context.length|token.limit.exceeded|maximum.context/i.test(errorMessage);
}

/**
 * The endpoint rejected the requested model name — the proxy no longer routes
 * it (an Anthropic-compatible gateway whose alias set changed, a model that
 * went end-of-life, ...). A session-level model override survives such a
 * change, so without this classifier every later turn fails the same way.
 */
export function isUnknownModelError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /unknown provider for model|unknown (?:model|provider)|model[^.]{0,40}not (?:found|available|supported)|invalid model|unrecognized model|no such model|model .* does not exist/i.test(
    errorMessage,
  );
}

/** Extract the model name from an unknown-model error, when present. */
export function modelFromUnknownModelError(errorMessage?: string): string | undefined {
  if (!errorMessage) return undefined;
  const match = /model[ `"']*([A-Za-z0-9._:/-]+)/i.exec(errorMessage);
  return match?.[1];
}
