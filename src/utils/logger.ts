import pino from 'pino';

const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [
    /((?:access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?key|authorization|password)["']?\s*[:=]\s*["']?)[^\s,;}\]"']+/gi,
    '$1[REDACTED]',
  ],
];

function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}

function sanitizeSdkLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) return serializeErrorForLog(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeSdkLogValue(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Axios puts credentials in headers under these keys — skip the whole tree.
    if (/^(?:config|request)$/i.test(key)) continue;
    if (/(?:token|secret|password|authorization|credential|private.?key)/i.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeSdkLogValue(item, depth + 1);
  }
  return output;
}

/** Keep useful failure evidence without serializing Axios request headers/config. */
export function serializeErrorForLog(error: unknown): unknown {
  if (typeof error === 'string') return redactSensitiveText(error);
  if (!(error instanceof Error)) {
    return { type: 'UnknownError', message: redactSensitiveText(String(error)) };
  }

  const source = error as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown; message?: unknown } };
  };
  const result: Record<string, unknown> = {
    type: error.name || 'Error',
    message: redactSensitiveText(error.message),
  };
  if (error.stack) result.stack = redactSensitiveText(error.stack);
  if (typeof source.code === 'string' || typeof source.code === 'number') result.code = source.code;
  const status = source.status ?? source.response?.status;
  if (typeof status === 'string' || typeof status === 'number') result.status = status;
  const remoteCode = source.response?.data?.code;
  if (typeof remoteCode === 'string' || typeof remoteCode === 'number') result.remoteCode = remoteCode;
  const remoteMessage = source.response?.data?.msg ?? source.response?.data?.message;
  if (typeof remoteMessage === 'string') result.remoteMessage = redactSensitiveText(remoteMessage);
  return result;
}

/** Route Feishu SDK diagnostics through pino without serializing request config or credentials. */
export function createLarkSdkLogger(logger: Logger) {
  const payload = (messages: unknown[]) => ({
    sdk: 'feishu',
    messages: messages.map((message) => sanitizeSdkLogValue(message)),
  });
  return {
    error: (...messages: unknown[]) => logger.error(payload(messages), 'Feishu SDK error'),
    warn: (...messages: unknown[]) => logger.warn(payload(messages), 'Feishu SDK warning'),
    info: (...messages: unknown[]) => logger.info(payload(messages), 'Feishu SDK info'),
    debug: (...messages: unknown[]) => logger.debug(payload(messages), 'Feishu SDK debug'),
    trace: (...messages: unknown[]) => logger.trace(payload(messages), 'Feishu SDK trace'),
  };
}

export function createLogger(level: string) {
  return pino({
    level,
    serializers: {
      err: serializeErrorForLog,
      error: serializeErrorForLog,
    },
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });
}

export type Logger = pino.Logger;
