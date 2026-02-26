import { CronExpressionParser } from 'cron-parser';

const DEFAULT_TIMEZONE = process.env.SCHEDULE_TIMEZONE || 'Asia/Shanghai';

/**
 * Validate a 5-field cron expression (minute hour dom month dow).
 * Also accepts predefined aliases like @daily, @hourly, etc.
 */
export function isValidCron(expr: string): boolean {
  try {
    if (expr.startsWith('@')) {
      CronExpressionParser.parse(expr);
      return true;
    }
    // Ensure exactly 5 fields (minute hour dom month dow)
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    // Prepend seconds field for cron-parser v5 (expects 6 fields)
    CronExpressionParser.parse(`0 ${expr}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next occurrence after `afterDate` (default: now).
 * Returns Unix ms timestamp.
 * @param expr - 5-field cron expression or predefined alias
 * @param timezone - IANA timezone string
 * @param afterDate - Date to compute next occurrence from
 */
export function nextCronOccurrence(
  expr: string,
  timezone?: string,
  afterDate?: Date,
): number {
  const tz = timezone || DEFAULT_TIMEZONE;
  const fullExpr = expr.startsWith('@') ? expr : `0 ${expr}`;
  const options: Record<string, unknown> = { tz };
  if (afterDate) {
    options.currentDate = afterDate;
  }
  const parsed = CronExpressionParser.parse(fullExpr, options);
  const next = parsed.next();
  return next.getTime();
}

/**
 * Return default timezone from env or fallback.
 */
export function getDefaultTimezone(): string {
  return DEFAULT_TIMEZONE;
}
