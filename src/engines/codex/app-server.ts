import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, SDKMessage } from '../claude/executor.js';
import { createCodexTranslatorState, translateCodexJsonEvent, type CodexJsonEvent } from './jsonl-translator.js';

interface Item {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
}
interface Params {
  threadId?: string;
  turnId?: string;
  turn?: { id: string; status: string; error?: { message?: string } };
  item?: Item;
  tokenUsage?: {
    last: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number };
    modelContextWindow?: number;
  };
  questions?: Array<{ id: string; header: string; question: string; options?: Array<{ label: string; description: string }> }>;
}
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string; code?: number };
}

export interface AppServerRun extends ExecutionHandle {
  canSteer(): boolean;
  steer(text: string): Promise<'steered' | 'no-active-turn'>;
}

/** A private stdio app-server per turn; persisted thread IDs survive process teardown. */
export function startAppServerRun(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  contextWindow?: number;
  effort?: string;
  approvalPolicy: string;
  sandbox: string;
  signal: AbortSignal;
  logger: Logger;
}): AppServerRun {
  const queue = new AsyncQueue<SDKMessage>();
  const state = createCodexTranslatorState({ model: input.model, contextWindow: input.contextWindow });
  state.sessionId = input.sessionId;
  let child: ChildProcess | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let done = false;
  let sequence = 0;
  let stderr = '';
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const questions = new Map<string, { id: number | string; questions: NonNullable<Params['questions']> }>();
  const emit = (event: CodexJsonEvent) => {
    for (const message of translateCodexJsonEvent(event, state)) queue.enqueue(message);
  };
  const write = (message: unknown) => {
    if (!child?.stdin?.writable || done) throw new Error('Codex app-server connection is closed');
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const request = <T = unknown>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server request timed out: ${method}`));
    }, 60_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    try { write({ id, method, params }); }
    catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
  const close = () => {
    input.signal.removeEventListener('abort', abort);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex app-server connection closed'));
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
    emit(error ? { type: 'turn.failed', error: { message: error } } : { type: 'turn.completed' });
    done = true;
    queue.finish();
    close();
  };
  const abort = () => finish('Task was stopped');
  const respondToQuestion = (toolId: string, answers: Record<string, string>) => {
    const q = questions.get(toolId);
    if (!q || done) return;
    const mapped = Object.fromEntries(q.questions.map(question => [
      question.id, { answers: [answers[question.question] ?? answers[question.id] ?? ''] },
    ]));
    write({ id: q.id, result: { answers: mapped } });
    questions.delete(toolId);
  };
  const receive = (message: RpcMessage) => {
    if (done) return;
    if (message.id !== undefined && !message.method) {
      const p = pending.get(Number(message.id));
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(Number(message.id));
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.id !== undefined) {
      if (message.method === 'item/tool/requestUserInput' && params.questions && params.threadId === threadId) {
        const toolId = `codex-question-${message.id}`;
        questions.set(toolId, { id: message.id, questions: params.questions });
        queue.enqueue({ type: 'assistant', session_id: threadId, message: { content: [{
          type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions: params.questions },
        }] } });
      } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        write({ id: message.id, result: { decision: 'decline' } });
      } else {
        write({ id: message.id, error: { code: -32601, message: 'Interactive request is not supported by this MetaBot transport' } });
      }
      return;
    }
    if (!threadId || params.threadId !== threadId) return;
    if (message.method === 'turn/started') turnId = params.turn?.id;
    if (message.method === 'thread/tokenUsage/updated' && params.tokenUsage) {
      const usage = params.tokenUsage.last;
      emit({ type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: params.tokenUsage.modelContextWindow,
        last_token_usage: {
          input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens, cached_input_tokens: usage.cachedInputTokens,
        },
      } } });
    }
    const item = params.item;
    if (item && (message.method === 'item/started' || message.method === 'item/completed')) {
      if (item.type === 'agentMessage' && message.method === 'item/completed') {
        emit({ type: 'item.completed', item: { id: item.id, type: 'agent_message', text: item.text } });
      } else if (item.type === 'commandExecution') {
        emit({ type: message.method === 'item/started' ? 'item.started' : 'item.completed', item: {
          id: item.id, type: 'command_execution', command: item.command,
          aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
        } });
      }
    }
    if (message.method === 'turn/completed' && params.turn && (!turnId || params.turn.id === turnId)) {
      const turn = params.turn;
      finish(turn.status === 'completed' ? undefined : turn.error?.message || `Codex turn ${turn.status}`);
    }
  };

  try {
    child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      try { receive(JSON.parse(line) as RpcMessage); }
      catch (err) { input.logger.warn({ err }, 'Invalid Codex app-server message'); }
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin?.on('error', err => finish(err.message));
    child.on('error', err => finish(err.message));
    child.on('close', code => {
      lines.close();
      if (!done) finish(`Codex app-server exited before completion (code ${code})${stderr ? ': ' + stderr : ''}`);
    });
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    else void (async () => {
      await request('initialize', { clientInfo: { name: 'metabot', title: 'MetaBot', version: '1.3.2' } });
      write({ method: 'initialized', params: {} });
      const result = await request<{ thread: { id: string } }>(input.sessionId ? 'thread/resume' : 'thread/start', {
        ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
        cwd: input.cwd, model: input.model, approvalPolicy: input.approvalPolicy, sandbox: input.sandbox,
      });
      threadId = result.thread.id;
      emit({ type: 'thread.started', thread_id: threadId });
      const started = await request<{ turn: { id: string } }>('turn/start', {
        threadId, input: [{ type: 'text', text: input.prompt }], effort: input.effort,
      });
      turnId = started.turn.id;
    })().catch(err => finish(err instanceof Error ? err.message : String(err)));
  } catch (err) {
    finish(err instanceof Error ? err.message : String(err));
  }

  return {
    stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
    canSteer: () => !done && !!threadId && !!turnId,
    async steer(text) {
      if (done || !threadId || !turnId) return 'no-active-turn';
      const expectedTurnId = turnId;
      const result = await request<{ turnId: string }>('turn/steer', {
        threadId, expectedTurnId, input: [{ type: 'text', text }],
      });
      if (result.turnId !== expectedTurnId) throw new Error('Codex accepted input for an unexpected turn');
      return 'steered';
    },
    sendAnswer(toolUseId, _sessionId, text) {
      const q = questions.get(toolUseId);
      if (q) respondToQuestion(toolUseId, Object.fromEntries(q.questions.map(question => [question.id, text])));
    },
    resolveQuestion: respondToQuestion,
    finish() {
      if (!done) { done = true; queue.finish(); }
      close();
    },
  };
}
