/**
 * Transcript reader — moved to @metabot/shared.
 *
 * This file is now a thin re-export so existing src/* imports keep working.
 * New code in cloud/ or future shared/ modules should import from
 * `@metabot/shared` directly.
 */
export {
  readTranscript,
  type TranscriptToolCall,
  type TranscriptMessage,
  type ReadTranscriptResult,
} from '@metabot/shared/transcript';
