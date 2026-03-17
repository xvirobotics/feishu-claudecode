import * as crypto from 'node:crypto';
import type { ApiTaskResult } from '../bridge/message-bridge.js';
import type { Logger } from '../utils/logger.js';

export interface AsyncTask {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: ApiTaskResult;
  createdAt: number;
  completedAt?: number;
  /** For peer-forwarded tasks: remote peer URL + taskId */
  peerRef?: { url: string; taskId: string; secret?: string };
}

const RESULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ACTIVE_TASKS = 50;

export class AsyncTaskManager {
  private tasks = new Map<string, AsyncTask>();
  private sweepInterval: ReturnType<typeof setInterval>;

  constructor(private logger: Logger) {
    this.sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  create(botName: string, chatId: string, prompt: string): string {
    const activeCount = [...this.tasks.values()].filter(
      (t) => t.status === 'pending' || t.status === 'running',
    ).length;
    if (activeCount >= MAX_ACTIVE_TASKS) {
      throw Object.assign(new Error('Too many active async tasks'), { statusCode: 429 });
    }

    const id = crypto.randomUUID();
    this.tasks.set(id, {
      id,
      botName,
      chatId,
      prompt,
      status: 'pending',
      createdAt: Date.now(),
    });
    return id;
  }

  get(taskId: string): AsyncTask | undefined {
    return this.tasks.get(taskId);
  }

  setRunning(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'pending') {
      task.status = 'running';
    }
  }

  complete(taskId: string, result: ApiTaskResult): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = result.success ? 'complete' : 'error';
    task.result = result;
    task.completedAt = Date.now();
    this.logger.info({ taskId, status: task.status, durationMs: result.durationMs }, 'Async task completed');
  }

  /** Create a proxy entry for a peer-forwarded async task */
  createPeerProxy(botName: string, chatId: string, prompt: string, peerRef: AsyncTask['peerRef']): string {
    const id = crypto.randomUUID();
    this.tasks.set(id, {
      id,
      botName,
      chatId,
      prompt,
      status: 'running',
      createdAt: Date.now(),
      peerRef,
    });
    return id;
  }

  listActive(): AsyncTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.status === 'pending' || t.status === 'running',
    );
  }

  private sweep(): void {
    const now = Date.now();
    let swept = 0;
    for (const [id, task] of this.tasks) {
      if (task.completedAt && now - task.completedAt > RESULT_TTL_MS) {
        this.tasks.delete(id);
        swept++;
      }
    }
    if (swept > 0) {
      this.logger.debug({ swept }, 'Swept expired async task results');
    }
  }

  destroy(): void {
    clearInterval(this.sweepInterval);
    this.tasks.clear();
  }
}
