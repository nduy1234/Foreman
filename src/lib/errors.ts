import { z } from 'zod';

/** Error helpers shared by resolvers, actions and the job consumer. */

export function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

export function isConsentError(err: unknown): boolean {
  const e = err as { code?: string; name?: string };
  return e?.code === 'NEEDS_AUTHENTICATION_ERR' || e?.name === 'NeedsAuthenticationError';
}

export type RetryDecision =
  | { retry: true; afterSeconds: number; reason: 'FUNCTION_UPSTREAM_RATE_LIMITED' | 'FUNCTION_RETRY_REQUEST' }
  | { retry: false };

/**
 * Should a failed background job be retried by the platform? Rate limits and transient upstream
 * failures (5xx, timeouts, connection resets) get up to `maxRetries` retries with growing delays;
 * validation, permission and "not found" errors fail immediately.
 */
export function classifyJobError(err: unknown, retryCount: number, maxRetries = 2): RetryDecision {
  if (retryCount >= maxRetries) return { retry: false };
  const status = statusOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 429 || /rate.?limit|429|too many requests/i.test(msg)) {
    return { retry: true, afterSeconds: 60 * (retryCount + 1), reason: 'FUNCTION_UPSTREAM_RATE_LIMITED' };
  }
  if ((status !== undefined && status >= 500) || /timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|503|502|504/i.test(msg)) {
    return { retry: true, afterSeconds: 20 * (retryCount + 1), reason: 'FUNCTION_RETRY_REQUEST' };
  }
  return { retry: false };
}

/** Readable message for anything thrown from a resolver (shown in the UI). */
export function userMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `Invalid input: ${err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'value'} ${i.message.toLowerCase()}`)
      .join('; ')}`;
  }
  const status = statusOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 403 || / 403:/.test(msg)) return 'Jira refused this action: you may not have permission for that project or work item.';
  if (status === 404 || / 404:/.test(msg)) return 'That item no longer exists or you cannot see it.';
  if (status === 429 || / 429:/.test(msg)) return 'Jira is rate limiting requests right now. Wait a minute and try again.';
  if ((status ?? 0) >= 500 || / 5\d\d:/.test(msg)) return 'Jira or Confluence had a temporary problem. Try again in a minute.';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
