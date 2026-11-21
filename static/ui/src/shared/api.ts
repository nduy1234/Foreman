import { invoke } from '@forge/bridge';

export interface Status {
  ok: boolean;
  version: string;
  accountId: string | null;
  projectKey: string | null;
  issueKey: string | null;
  serverTime: string;
}

export interface Job {
  id: number;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  message: string | null;
  result: unknown;
  error: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actorKind: string;
  action: string;
  target: string | null;
}

/** invoke() with retry on 429, using Forge's rate-limit reset metadata. */
export async function call<T>(key: string, payload?: Record<string, unknown>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await invoke<T>(key, payload, { rateLimitProperties: true } as never);
      return ((res as { body?: T })?.body ?? res) as T;
    } catch (err) {
      const e = err as { statusCode?: number; status?: number; metadata?: { rateLimitProperties?: { rateLimitReset?: number } } };
      const status = e.statusCode ?? e.status;
      if (status !== 429 || i >= attempts) throw err;
      const reset = e.metadata?.rateLimitProperties?.rateLimitReset;
      const wait = reset ? Math.max(0, reset * 1000 - Date.now()) : 1000 * i;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Poll a job until done/failed. */
export async function waitForJob(jobId: number, onUpdate: (j: Job) => void, timeoutMs = 5 * 60_000): Promise<Job> {
  const start = Date.now();
  let delay = 800;
  for (;;) {
    const job = await call<Job | null>('getJob', { jobId });
    if (job) {
      onUpdate(job);
      if (job.state === 'done' || job.state === 'failed') return job;
    }
    if (Date.now() - start > timeoutMs) throw new Error('Job timed out');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 4000);
  }
}
