import { kvs } from '@forge/kvs';
import { audit } from '../lib/audit';
import { runMigrations } from '../lib/db';
import { enqueueJob } from '../lib/jobs';
import { monitoredProjects } from '../services/monitor/store';

/** avi:forge:installed:app / avi:forge:upgraded:app -> apply SQL migrations. */
export async function lifecycle(event: { eventType?: string }) {
  const applied = await runMigrations();
  await audit({ actorAccountId: null, actorKind: 'system', action: 'app.lifecycle', target: 'app', after: { event: event?.eventType, applied } });
}

/** Hourly: queue a monitor scan per monitored project (each scan gets up to 900 s in the consumer). */
export async function monitorHourly() {
  for (const projectKey of await monitoredProjects()) {
    await enqueueJob('monitor_scan', { projectKey, reason: 'hourly' }, null);
  }
}

/** Daily: scan + digest per project. */
export async function digestDaily() {
  for (const projectKey of await monitoredProjects()) {
    await enqueueJob('monitor_scan', { projectKey, reason: 'daily', digest: true }, null);
  }
}

interface IssueEvent {
  eventType: string;
  issue?: { key?: string; fields?: { issuetype?: { name?: string }; project?: { key?: string } } };
  atlassianId?: string;
}

const TRACKED = ['Permit', 'Inspection', 'RFI', 'Punch Item', 'Code Finding'];
export const DEBOUNCE_MS = 90_000;

/** Pure debounce decision; exported for tests. */
export function shouldQueueScan(lastQueuedAt: number | undefined, now: number): boolean {
  return !lastQueuedAt || now - lastQueuedAt >= DEBOUNCE_MS;
}

/**
 * Jira issue events -> debounced rescan of that project. A burst of edits produces one scan
 * about a minute later instead of one per edit. Changes made by the app itself are filtered
 * out in the manifest (ignoreSelf).
 */
export async function issueEvents(event: IssueEvent) {
  const type = event.issue?.fields?.issuetype?.name;
  const projectKey = event.issue?.fields?.project?.key ?? event.issue?.key?.split('-')[0];
  if (!type || !TRACKED.includes(type) || !projectKey) return;
  if (!(await monitoredProjects()).includes(projectKey)) return;
  const k = `monitor:queuedAt:${projectKey}`;
  const now = Date.now();
  if (!shouldQueueScan((await kvs.get(k)) as number | undefined, now)) return;
  await kvs.set(k, now);
  await enqueueJob('monitor_scan', { projectKey, reason: `${event.eventType} ${event.issue?.key}` }, event.atlassianId ?? null, 60);
}
