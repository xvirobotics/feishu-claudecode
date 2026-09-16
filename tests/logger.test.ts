import { describe, expect, it } from 'vitest';
import { createLarkSdkLogger, serializeErrorForLog } from '../src/utils/logger.js';

describe('logger error serialization', () => {
  it('keeps remote failure evidence without request headers or tokens', () => {
    const error = Object.assign(new Error('request failed: Bearer secret-token'), {
      code: 'ERR_BAD_REQUEST',
      config: { headers: { Authorization: 'Bearer secret-token' } },
      response: { status: 400, data: { code: 123, msg: 'authorization: secret-token' } },
    });

    const serialized = JSON.stringify(serializeErrorForLog(error));

    expect(serialized).toContain('ERR_BAD_REQUEST');
    expect(serialized).toContain('123');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('headers');
    expect(serialized).not.toContain('config');
  });

  it('redacts credential-shaped values in plain strings', () => {
    expect(serializeErrorForLog('failed with Bearer abc.def-ghi')).toBe('failed with Bearer [REDACTED]');
  });

  it('wraps non-Error values without leaking credentials', () => {
    expect(serializeErrorForLog({ authorization: 'Bearer abc.def-ghi' })).toEqual({
      type: 'UnknownError',
      message: '[object Object]',
    });
  });
});

describe('createLarkSdkLogger', () => {
  function createRecordingLogger() {
    const records: unknown[] = [];
    const logger = {
      error: (...args: unknown[]) => records.push(args),
      warn: (...args: unknown[]) => records.push(args),
      info: (...args: unknown[]) => records.push(args),
      debug: (...args: unknown[]) => records.push(args),
      trace: (...args: unknown[]) => records.push(args),
    } as any;
    return { logger, records };
  }

  it('routes SDK diagnostics through the same sanitizer', () => {
    const { logger, records } = createRecordingLogger();
    const sdkLogger = createLarkSdkLogger(logger);
    const error = Object.assign(new Error('request failed'), {
      config: { data: '{"app_secret":"must-not-leak"}' },
      request: { headers: { Authorization: 'Bearer must-not-leak' } },
    });

    sdkLogger.error('[ws]', error);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('"config"');
    expect(serialized).not.toContain('"request":');
    expect(serialized).toContain('request failed');
  });

  it('redacts credential-named fields in structured values', () => {
    const { logger, records } = createRecordingLogger();
    const sdkLogger = createLarkSdkLogger(logger);

    sdkLogger.info({ appId: 'cli_0123', appSecret: 'must-not-leak' });

    const serialized = JSON.stringify(records);
    expect(serialized).toContain('cli_0123');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('must-not-leak');
  });
});
