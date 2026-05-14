import type { Logger } from './logger.js';

export type AuditEvent =
  | 'task_start'
  | 'task_complete'
  | 'task_error'
  | 'task_timeout'
  | 'task_idle_timeout'
  | 'task_stopped'
  | 'task_queued'
  | 'queue_cleared'
  | 'command'
  | 'auth_denied'
  | 'api_task_start'
  | 'api_task_complete';

export interface AuditEntry {
  event: AuditEvent;
  botName: string;
  chatId: string;
  userId?: string;
  prompt?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * Lightweight audit logger built on pino. Emits structured log events
 * tagged with `audit: true` so they can be filtered from regular logs.
 * Usage: `auditLog.log({ event: 'task_start', botName, chatId, userId, prompt })`.
 */
export class AuditLogger {
  private logger: Logger;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child({ audit: true });
  }

  log(entry: AuditEntry): void {
    const { event, prompt, error, meta, ...rest } = entry;
    this.logger.info({
      ...rest,
      event,
      // Truncate prompt to avoid bloating logs
      prompt: prompt ? prompt.slice(0, 200) : undefined,
      error: error ? error.slice(0, 500) : undefined,
      ...meta,
    }, `audit:${event}`);
  }
}
