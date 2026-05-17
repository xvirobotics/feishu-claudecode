/**
 * Compose the storage/lookup key used to scope per-conversation state
 * (Claude session, persistent executor, message queue, running task, etc).
 *
 * Default behavior keys by chatId alone — one shared context per chat. When
 * a bot opts in via `perUserContext: true`, the key becomes `chatId:userId`
 * so each Feishu user inside the same group chat keeps their own thread.
 *
 * p2p chats already have a 1:1 chatId-to-user mapping, so for them the
 * composed key changes shape but does not change semantics; group chats
 * are where this matters.
 */
export function composeScopeKey(
  chatId: string,
  userId: string | undefined,
  perUserContext: boolean | undefined,
): string {
  if (!perUserContext || !userId) return chatId;
  return `${chatId}:${userId}`;
}

/**
 * Recover the chatId from a composed scope key produced by
 * {@link composeScopeKey}. Useful when state is keyed by scope but the IM
 * delivery channel still needs the original chatId.
 *
 * Falls back to returning the input unchanged when the key does not contain
 * a userId segment (chatId-only mode), since Feishu open_ids start with
 * `ou_` and chat_ids with `oc_` — the separator only appears for composed
 * keys.
 */
export function chatIdFromScopeKey(scopeKey: string): string {
  const idx = scopeKey.indexOf(':');
  if (idx < 0) return scopeKey;
  return scopeKey.slice(0, idx);
}

/**
 * Recover the userId portion of a composed scope key, or undefined when the
 * key is chatId-only.
 */
export function userIdFromScopeKey(scopeKey: string): string | undefined {
  const idx = scopeKey.indexOf(':');
  if (idx < 0) return undefined;
  return scopeKey.slice(idx + 1) || undefined;
}
