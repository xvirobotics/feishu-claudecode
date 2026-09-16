import { describe, it, expect, vi } from 'vitest';
import { AuditLogger } from '../src/utils/audit-logger.js';

describe('AuditLogger', () => {
  function createMockLogger() {
    const childLogger = { info: vi.fn() };
    const parentLogger = { child: vi.fn().mockReturnValue(childLogger) };
    return { parentLogger, childLogger };
  }

  it('creates a child logger with audit:true tag', () => {
    const { parentLogger } = createMockLogger();
    new AuditLogger(parentLogger as any);
    expect(parentLogger.child).toHaveBeenCalledWith({ audit: true });
  });

  it('logs an audit event with info level', () => {
    const { parentLogger, childLogger } = createMockLogger();
    const audit = new AuditLogger(parentLogger as any);

    audit.log({
      event: 'task_start',
      botName: 'test-bot',
      chatId: 'chat123',
      userId: 'user456',
      prompt: 'hello world',
    });

    expect(childLogger.info).toHaveBeenCalledTimes(1);
    const [data, msg] = childLogger.info.mock.calls[0];
    expect(msg).toBe('audit:task_start');
    expect(data.botName).toBe('test-bot');
    expect(data.chatId).toBe('chat123');
    expect(data.prompt).toBe('hello world');
  });

  it('truncates long prompts to 200 chars', () => {
    const { parentLogger, childLogger } = createMockLogger();
    const audit = new AuditLogger(parentLogger as any);

    const longPrompt = 'x'.repeat(500);
    audit.log({
      event: 'task_start',
      botName: 'bot',
      chatId: 'chat',
      prompt: longPrompt,
    });

    const [data] = childLogger.info.mock.calls[0];
    expect(data.prompt).toHaveLength(200);
  });

  it('truncates long error to 500 chars', () => {
    const { parentLogger, childLogger } = createMockLogger();
    const audit = new AuditLogger(parentLogger as any);

    audit.log({
      event: 'task_error',
      botName: 'bot',
      chatId: 'chat',
      error: 'e'.repeat(1000),
    });

    const [data] = childLogger.info.mock.calls[0];
    expect(data.error).toHaveLength(500);
  });

  it('passes through meta fields', () => {
    const { parentLogger, childLogger } = createMockLogger();
    const audit = new AuditLogger(parentLogger as any);

    audit.log({
      event: 'task_queued',
      botName: 'bot',
      chatId: 'chat',
      meta: { position: 3 },
    });

    const [data] = childLogger.info.mock.calls[0];
    expect(data.position).toBe(3);
  });

  it('omits the prompt when METABOT_AUDIT_INCLUDE_PROMPT=false', () => {
    const previous = process.env.METABOT_AUDIT_INCLUDE_PROMPT;
    process.env.METABOT_AUDIT_INCLUDE_PROMPT = 'false';
    try {
      const { parentLogger, childLogger } = createMockLogger();
      const audit = new AuditLogger(parentLogger as any);

      audit.log({
        event: 'task_start',
        botName: 'bot',
        chatId: 'chat',
        prompt: 'sensitive prompt',
      });

      const [data] = childLogger.info.mock.calls[0];
      expect(data.prompt).toBeUndefined();
      // Everything else is still audited.
      expect(data.botName).toBe('bot');
      expect(data.chatId).toBe('chat');
      expect(childLogger.info.mock.calls[0][1]).toBe('audit:task_start');
    } finally {
      if (previous === undefined) delete process.env.METABOT_AUDIT_INCLUDE_PROMPT;
      else process.env.METABOT_AUDIT_INCLUDE_PROMPT = previous;
    }
  });
});
