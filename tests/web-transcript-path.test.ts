/**
 * Pure-function tests for the transcript SPA path helpers.
 *
 * The helpers run inside the browser SPA (`web/src/utils/transcriptPath.ts`)
 * but are deliberately dependency-free so they can be unit-tested without
 * jsdom. They guard the contract that the same Vite build is correctly served
 * from BOTH the local mount (`/web/transcript/...`) and the cloud relay mount
 * (`/i/<instanceId>/web/transcript/...`).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveApiBase,
  deriveRouterBasename,
} from '../web/src/utils/transcriptPath';

describe('deriveApiBase', () => {
  it('returns empty string for local mount root', () => {
    expect(deriveApiBase('/web/transcript/abc')).toBe('');
  });

  it('returns empty string for local mount with query-like suffix', () => {
    expect(deriveApiBase('/web/transcript/abc/extra/path')).toBe('');
  });

  it('returns instance prefix for cloud mount', () => {
    expect(deriveApiBase('/i/host-a/web/transcript/abc')).toBe('/i/host-a');
  });

  it('preserves instance id with hyphens and underscores', () => {
    expect(deriveApiBase('/i/host-a_2/web/transcript/oc_abc')).toBe('/i/host-a_2');
  });

  it('returns empty string when path is not a transcript route (defensive)', () => {
    expect(deriveApiBase('/manager/dashboard')).toBe('');
    expect(deriveApiBase('/')).toBe('');
    expect(deriveApiBase('')).toBe('');
  });

  it('handles non-string defensively', () => {
    expect(deriveApiBase(undefined as unknown as string)).toBe('');
  });
});

describe('deriveRouterBasename', () => {
  it('returns /web for local mount', () => {
    expect(deriveRouterBasename('/web/transcript/abc')).toBe('/web');
  });

  it('returns /i/<id>/web for cloud mount', () => {
    expect(deriveRouterBasename('/i/host-a/web/transcript/abc?turn=2')).toBe(
      '/i/host-a/web',
    );
  });

  it('returns /web for non-transcript paths', () => {
    expect(deriveRouterBasename('/manager/dashboard')).toBe('/web');
  });
});
