import api, { route } from '@forge/api';
import { HttpError, withRetry } from './retry';

/**
 * Thin Jira REST client. All calls retry on 429/5xx and honor Retry-After.
 * `as: 'user'` acts with the invoking user's permissions (resolvers only);
 * `as: 'app'` acts as the app (needed for app-owned custom field values, triggers, consumers).
 */
export type Principal = 'user' | 'app';
type Route = ReturnType<typeof route>;

export interface JiraRequest {
  as: Principal;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Treat these statuses as success and return null body (e.g. 404 on lookups). */
  allow?: number[];
}

function requester(as: Principal) {
  return as === 'user' ? api.asUser() : api.asApp();
}

export async function jira<T = unknown>(path: Route, req: JiraRequest): Promise<T> {
  return withRetry(async () => {
    const isForm = typeof FormData !== 'undefined' && req.body instanceof FormData;
    const res = await requester(req.as).requestJira(path, {
      method: req.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(req.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...req.headers,
      },
      body: req.body === undefined ? undefined : isForm ? (req.body as never) : JSON.stringify(req.body),
    });
    if (req.allow?.includes(res.status)) return null as T;
    if (!res.ok) {
      const text = await res.text();
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new HttpError(
        `Jira ${req.method ?? 'GET'} ${String((path as unknown as { value?: string }).value ?? path)} -> ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        text,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    if (res.status === 204) return null as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  });
}

/** Run async tasks with bounded concurrency, preserving order. */
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I, idx: number) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Minimal Atlassian Document Format builder. */
export function adf(...paragraphs: string[]) {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
  };
}

export { route };
