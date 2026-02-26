import { describe, it, expect } from 'vitest';
import { isValidCron, nextCronOccurrence, getDefaultTimezone } from '../src/scheduler/cron-utils.js';

describe('cron-utils', () => {
  describe('isValidCron', () => {
    it('accepts standard 5-field expressions', () => {
      expect(isValidCron('0 8 * * *')).toBe(true);       // daily 8am
      expect(isValidCron('*/5 * * * *')).toBe(true);      // every 5 min
      expect(isValidCron('0 8 * * 1-5')).toBe(true);      // weekdays 8am
      expect(isValidCron('30 9 1 * *')).toBe(true);       // 1st of month 9:30
      expect(isValidCron('0 0 * * 0')).toBe(true);        // sunday midnight
    });

    it('accepts predefined aliases', () => {
      expect(isValidCron('@daily')).toBe(true);
      expect(isValidCron('@hourly')).toBe(true);
      expect(isValidCron('@weekly')).toBe(true);
      expect(isValidCron('@monthly')).toBe(true);
      expect(isValidCron('@yearly')).toBe(true);
    });

    it('rejects invalid expressions', () => {
      expect(isValidCron('invalid')).toBe(false);
      expect(isValidCron('0 8 * *')).toBe(false);         // only 4 fields
      expect(isValidCron('60 8 * * *')).toBe(false);       // minute out of range
      expect(isValidCron('0 25 * * *')).toBe(false);       // hour out of range
      expect(isValidCron('')).toBe(false);
    });
  });

  describe('nextCronOccurrence', () => {
    it('returns a future timestamp', () => {
      const now = Date.now();
      const next = nextCronOccurrence('* * * * *', 'UTC');
      expect(next).toBeGreaterThan(now - 1000); // within 1 second tolerance
    });

    it('respects afterDate parameter', () => {
      // "0 8 * * *" = daily 8am UTC
      // If afterDate is 2025-01-15 07:00 UTC, next should be 2025-01-15 08:00 UTC
      const afterDate = new Date('2025-01-15T07:00:00Z');
      const next = nextCronOccurrence('0 8 * * *', 'UTC', afterDate);
      const expected = new Date('2025-01-15T08:00:00Z').getTime();
      expect(next).toBe(expected);
    });

    it('advances past afterDate when already past the time', () => {
      // If afterDate is 2025-01-15 09:00 UTC (past 8am), next should be 2025-01-16 08:00 UTC
      const afterDate = new Date('2025-01-15T09:00:00Z');
      const next = nextCronOccurrence('0 8 * * *', 'UTC', afterDate);
      const expected = new Date('2025-01-16T08:00:00Z').getTime();
      expect(next).toBe(expected);
    });

    it('handles timezone correctly', () => {
      // "0 8 * * *" with Asia/Shanghai (+8) → 8:00 CST = 00:00 UTC
      const afterDate = new Date('2025-01-15T00:00:01Z'); // just past midnight UTC = 8:00:01 CST
      const next = nextCronOccurrence('0 8 * * *', 'Asia/Shanghai', afterDate);
      // Next 8am Shanghai = 2025-01-16 00:00 UTC
      const expected = new Date('2025-01-16T00:00:00Z').getTime();
      expect(next).toBe(expected);
    });
  });

  describe('getDefaultTimezone', () => {
    it('returns Asia/Shanghai by default', () => {
      // SCHEDULE_TIMEZONE is not set in test env
      expect(getDefaultTimezone()).toBe('Asia/Shanghai');
    });
  });
});
