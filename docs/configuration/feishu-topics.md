# Feishu topic conversations

MetaBot gives the main conversation and each topic their own engine session in both Feishu group chats and bot direct messages. People replying within one topic share that topic's session. Different bots remain isolated as before.

The separation includes task queues, media batches, pending questions, `/reset`, `/stop`, model selection, executor state, and download/output directories. Main-chat session keys are unchanged, so existing main-chat history remains available. Previously shared topic history is not migrated into the new sessions.

## Starting a topic

A new topic starts with the user prompt and assistant response from the card it replies to. It does not inherit the main conversation's other turns. The first turn receives this as quoted context; subsequent turns resume the topic's own engine session. `/reset` clears the topic without re-importing the origin.

Turn snapshots are stored per bot beneath `SESSION_STORE_DIR/feishu-turns/` (default `~/.metabot/feishu-turns/`) with private file permissions. These contain conversation text and follow the operator's local retention policy. For older cards without a snapshot, MetaBot attempts to read only that root message through Feishu. If Feishu denies access or the root was deleted, no origin text is available; no unrelated session is used as fallback.

## Conversation addresses

Inside MetaBot, a topic has a durable `feishu-thread-...` conversation address derived from its Feishu chat ID and root message ID. Treat this as an opaque ID. Sessions, scheduled work, recovery, and API tasks use the same address. The Feishu sender resolves it to the original chat and root message, even after a process restart. No in-memory "latest thread" setting is involved.

The engine context shows the actual Feishu Chat ID separately from the conversation address. Use the conversation address for MetaBot task/session/schedule commands; use the real Chat ID for Feishu APIs. Existing schedules targeting the bare Chat ID continue to target the main conversation.

Reply delivery uses Feishu's reply API and never falls back to posting in the main conversation when a topic reply fails. Updating a streaming card still updates that same card.

## Mentioning a bot without text

In group chats, sending only an exact @mention of the bot (plain text or a rich-text post) asks the agent to read recent chat history before responding, including messages that did not mention it. Within a topic, the prompt supplies the Feishu chat and available thread/root IDs and asks for that topic's history.

History retrieval is performed by the agent using the operator's configured `lark-cli` and permissions; the bridge does not fetch history itself. If history cannot be read or does not establish a clear request, the agent is instructed to explain and ask what help is needed. Empty messages without an exact bot mention remain ignored, even when the group reply mode is `all`. Mentions with text or images retain their existing behavior.
