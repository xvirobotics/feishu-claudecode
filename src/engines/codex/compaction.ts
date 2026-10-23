import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, SDKMessage } from '../claude/executor.js';

/** Run a native compaction of an idle persisted thread without adding a user turn. */
export function startCodexCompaction(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sessionId: string;
  model?: string;
  approvalPolicy: string;
  sandbox: string;
  signal: AbortSignal;
}): ExecutionHandle {
  const queue = new AsyncQueue<SDKMessage>();
  let child: ChildProcess | undefined;
  let sequence = 0;
  let done = false;
  let compacted = false;
  let turnId: string | undefined;
  const startedAt = Date.now();
  const pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const write = (value: unknown) => {
    if (done || !child?.stdin?.writable) throw new Error('Codex compaction connection is closed');
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const request = <T = unknown>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex compaction request timed out: ${method}`));
    }, 60_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    try { write({ id, method, params }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
  const cleanup = () => {
    input.signal.removeEventListener('abort', abort);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex compaction connection closed'));
    }
    pending.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1000);
      timer.unref();
    }
  };
  const finish = (error?: string) => {
    if (done) return;
    if (!error && !compacted) error = 'Codex did not confirm context compaction';
    done = true;
    queue.enqueue({
      type: 'result', subtype: error ? 'error_during_execution' : 'success',
      session_id: input.sessionId, duration_ms: Date.now() - startedAt,
      result: error ? '' : '上下文压缩完成，会话 ID 保持不变。',
      is_error: !!error, ...(error ? { errors: [error] } : {}),
    });
    queue.finish();
    cleanup();
  };
  const abort = () => finish('Task was stopped');
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stderr?.resume();
    child.stdin?.on('error', error => finish(error.message));
    child.on('error', error => finish(error.message));
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      if (done) return;
      let message: {
        id?: number | string;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: {
          threadId?: string;
          turnId?: string;
          turn?: { id: string; status: string; error?: { message?: string } };
          item?: { type: string };
        };
      };
      try { message = JSON.parse(line); }
      catch { finish('Invalid Codex compaction protocol message'); return; }
      if (message.id !== undefined && !message.method) {
        const p = pending.get(Number(message.id));
        if (!p) return;
        pending.delete(Number(message.id));
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
        return;
      }
      if (message.id !== undefined) {
        write({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported during compaction' } });
        return;
      }
      const params = message.params;
      if (params?.threadId !== input.sessionId) return;
      if (message.method === 'turn/started') turnId = params.turn?.id;
      if (message.method === 'item/completed' && params.item?.type === 'contextCompaction'
          && (!turnId || params.turnId === turnId)) compacted = true;
      if (message.method === 'turn/completed' && params.turn && (!turnId || params.turn.id === turnId)) {
        finish(params.turn.status === 'completed' ? undefined : params.turn.error?.message || `Codex turn ${params.turn.status}`);
      }
    });
    child.on('close', code => {
      lines.close();
      if (!done) finish(`Codex exited before compaction completed (code ${code})`);
    });
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    else void (async () => {
      await request('initialize', { clientInfo: { name: 'metabot', title: 'MetaBot', version: '1.3.2' } });
      write({ method: 'initialized', params: {} });
      const result = await request<{ thread: { id: string } }>('thread/resume', {
        threadId: input.sessionId, excludeTurns: true, cwd: input.cwd, model: input.model,
        approvalPolicy: input.approvalPolicy, sandbox: input.sandbox,
      });
      if (result.thread.id !== input.sessionId) throw new Error('Codex resumed an unexpected thread');
      await request('thread/compact/start', { threadId: input.sessionId });
    })().catch(error => finish(error instanceof Error ? error.message : String(error)));
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
  }
  return {
    stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
    sendAnswer() {},
    resolveQuestion() {},
    finish() {
      if (!done) { done = true; queue.finish(); }
      cleanup();
    },
  };
}
