export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return a delay (ms) to force, `true` to retry with backoff, `false` to stop. */
  shouldRetry?: (err: unknown, attempt: number) => boolean | number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Status-aware default: retry 429 and 5xx, honor Retry-After style hints. */
export function defaultShouldRetry(err: unknown): boolean | number {
  const e = err as { status?: number; statusCode?: number; retryAfterMs?: number };
  const status = e?.status ?? e?.statusCode;
  if (typeof e?.retryAfterMs === 'number') return e.retryAfterMs;
  if (status === undefined) return false;
  return status === 429 || status >= 500;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const should = opts.shouldRetry ?? defaultShouldRetry;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const verdict = should(err, attempt);
      if (verdict === false) break;
      const backoff = Math.min(max, base * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.25;
      await sleep(typeof verdict === 'number' ? verdict : backoff + jitter);
    }
  }
  throw lastErr;
}

/** Error carrying HTTP status so withRetry can classify it. */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
