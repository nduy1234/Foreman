import { Queue } from '@forge/events';
import { exec, parseJson, query } from './db';
import { JobEventBody, JobKind, JobState } from './schemas';

export const JOBS_QUEUE = 'foreman-jobs';
const queue = new Queue<JobEventBody>({ key: JOBS_QUEUE });

export interface Job {
  id: number;
  kind: JobKind;
  state: JobState;
  progress: number;
  message: string | null;
  result: unknown;
  error: string | null;
  updatedAt: string;
}

/** Create a job row and enqueue it for the async consumer (≤900 s runtime). */
export async function enqueueJob(kind: JobKind, input: Record<string, unknown>, createdBy: string | null, delayInSeconds?: number): Promise<number> {
  const { insertId } = await exec(
    `INSERT INTO jobs (kind, state, progress, input_json, created_by) VALUES (?, 'queued', 0, ?, ?)`,
    kind,
    JSON.stringify(input),
    createdBy,
  );
  await queue.push({ body: { jobId: insertId, kind, input }, ...(delayInSeconds ? { delayInSeconds } : {}) });
  return insertId;
}

export async function updateJob(
  id: number,
  patch: { state?: JobState; progress?: number; message?: string; result?: unknown; error?: string },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.state) (sets.push('state = ?'), params.push(patch.state));
  if (patch.progress !== undefined) (sets.push('progress = ?'), params.push(Math.round(patch.progress)));
  if (patch.message !== undefined) (sets.push('message = ?'), params.push(patch.message.slice(0, 255)));
  if (patch.result !== undefined) (sets.push('result_json = ?'), params.push(JSON.stringify(patch.result)));
  if (patch.error !== undefined) (sets.push('error = ?'), params.push(patch.error.slice(0, 4000)));
  if (!sets.length) return;
  await exec(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
}

interface RawJob {
  id: number;
  kind: JobKind;
  state: JobState;
  progress: number;
  message: string | null;
  result_json: unknown;
  error: string | null;
  updated_at: string;
}

export async function getJob(id: number): Promise<Job | null> {
  const [r] = await query<RawJob>(`SELECT id, kind, state, progress, message, result_json, error, updated_at FROM jobs WHERE id = ?`, id);
  if (!r) return null;
  return {
    id: Number(r.id),
    kind: r.kind,
    state: r.state,
    progress: Number(r.progress),
    message: r.message,
    result: parseJson(r.result_json),
    error: r.error,
    updatedAt: String(r.updated_at),
  };
}

/** Most recent job of a kind started from a given issue (input_json.issueKey). */
export async function latestJobForIssue(kind: JobKind, issueKey: string): Promise<Job | null> {
  const [r] = await query<{ id: number }>(
    `SELECT id FROM jobs WHERE kind = ? AND JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.issueKey')) = ? ORDER BY id DESC LIMIT 1`,
    kind,
    issueKey,
  );
  return r ? getJob(Number(r.id)) : null;
}
