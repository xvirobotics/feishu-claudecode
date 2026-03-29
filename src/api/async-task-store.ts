/**
 * In-memory store for async task status.
 *
 * When /api/talk receives `async: true`, the task is executed in the background
 * and this store tracks its lifecycle (accepted → running → completed/failed).
 * Completed tasks are automatically cleaned up after 1 hour.
 */

import * as crypto from 'node:crypto';

export interface AsyncTask {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  result?: {
    success: boolean;
    responseText: string;
    costUsd?: number;
    durationMs?: number;
    error?: string;
  };
  callbackChatId?: string;
  callbackBotName?: string;
}

export class AsyncTaskStore {
  private tasks = new Map<string, AsyncTask>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up completed tasks older than 1 hour
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 3600_000;
      for (const [id, task] of this.tasks) {
        if (task.completedAt && task.completedAt < cutoff) {
          this.tasks.delete(id);
        }
      }
    }, 300_000); // every 5 minutes
  }

  create(opts: {
    botName: string;
    chatId: string;
    prompt: string;
    callbackChatId?: string;
    callbackBotName?: string;
  }): AsyncTask {
    const task: AsyncTask = {
      id: crypto.randomUUID().slice(0, 8),
      botName: opts.botName,
      chatId: opts.chatId,
      prompt: opts.prompt,
      status: 'accepted',
      createdAt: Date.now(),
      callbackChatId: opts.callbackChatId,
      callbackBotName: opts.callbackBotName,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): AsyncTask | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<AsyncTask>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, updates);
    }
  }

  list(): AsyncTask[] {
    return Array.from(this.tasks.values());
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
