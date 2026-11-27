import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyJobError, isConsentError, userMessage } from '../src/lib/errors';
import { HttpError } from '../src/lib/retry';

describe('background job retry policy', () => {
  it('retries rate limits with growing delays, then gives up', () => {
    expect(classifyJobError(new HttpError('x', 429), 0)).toEqual({ retry: true, afterSeconds: 60, reason: 'FUNCTION_UPSTREAM_RATE_LIMITED' });
    expect(classifyJobError(new HttpError('x', 429), 1)).toMatchObject({ retry: true, afterSeconds: 120 });
    expect(classifyJobError(new HttpError('x', 429), 2)).toEqual({ retry: false });
  });
  it('retries transient upstream failures', () => {
    expect(classifyJobError(new HttpError('x', 503), 0)).toMatchObject({ retry: true, reason: 'FUNCTION_RETRY_REQUEST' });
    expect(classifyJobError(new Error('socket hang up'), 0)).toMatchObject({ retry: true });
    expect(classifyJobError(new Error('Request timed out'), 1)).toMatchObject({ retry: true, afterSeconds: 40 });
  });
  it('does not retry permanent errors', () => {
    expect(classifyJobError(new HttpError('x', 403), 0)).toEqual({ retry: false });
    expect(classifyJobError(new Error('Plan sheet A-999 not found'), 0)).toEqual({ retry: false });
  });
});

describe('user-facing resolver errors', () => {
  it('summarises validation errors', () => {
    const err = z.object({ sheetId: z.string().min(1) }).safeParse({ sheetId: '' }).error!;
    expect(userMessage(err)).toMatch(/^Invalid input: sheetId/);
  });
  it('maps HTTP statuses to plain language', () => {
    expect(userMessage(new HttpError('Jira POST -> 403: no', 403))).toMatch(/permission/);
    expect(userMessage(new HttpError('x', 429))).toMatch(/rate limiting/);
    expect(userMessage(new HttpError('x', 502))).toMatch(/temporary problem/);
    expect(userMessage(new Error('Choose at least one plan sheet'))).toBe('Choose at least one plan sheet');
  });
  it('recognises the Forge consent error so it can propagate', () => {
    expect(isConsentError({ code: 'NEEDS_AUTHENTICATION_ERR' })).toBe(true);
    expect(isConsentError(new Error('x'))).toBe(false);
  });
});
