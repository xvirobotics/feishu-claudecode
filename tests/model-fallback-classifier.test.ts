import { describe, it, expect } from 'vitest';
import {
  isUnknownModelError,
  modelFromUnknownModelError,
} from '../src/bridge/error-classifiers.js';

describe('isUnknownModelError', () => {
  it('matches the Anthropic-compatible proxy 400', () => {
    expect(isUnknownModelError('API Error: 400 unknown provider for model claude-fable-5')).toBe(true);
  });

  it('matches common unknown-model phrasings', () => {
    expect(isUnknownModelError('unknown model: foo')).toBe(true);
    expect(isUnknownModelError('invalid model name')).toBe(true);
    expect(isUnknownModelError('no such model bar')).toBe(true);
    expect(isUnknownModelError('the model gpt-6-astra does not exist')).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isUnknownModelError('context length exceeded')).toBe(false);
    expect(isUnknownModelError('ECONNREFUSED 127.0.0.1:443')).toBe(false);
    expect(isUnknownModelError('')).toBe(false);
    expect(isUnknownModelError(undefined)).toBe(false);
  });

  it('extracts the offending model name for the fallback notice', () => {
    expect(modelFromUnknownModelError('API Error: 400 unknown provider for model claude-fable-5'))
      .toBe('claude-fable-5');
    expect(modelFromUnknownModelError('no error here')).toBeUndefined();
  });
});
