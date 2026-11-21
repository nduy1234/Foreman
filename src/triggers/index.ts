import { audit } from '../lib/audit';
import { runMigrations } from '../lib/db';

/** avi:forge:installed:app / avi:forge:upgraded:app → apply SQL migrations. */
export async function lifecycle(event: { eventType?: string }) {
  const applied = await runMigrations();
  await audit({ actorAccountId: null, actorKind: 'system', action: 'app.lifecycle', target: 'app', after: { event: event?.eventType, applied } });
}

/** Hourly project scan. Real detection logic lands in Prompt 5. */
export async function monitorHourly() {
  await audit({ actorAccountId: null, actorKind: 'monitor', action: 'monitor.tick', target: 'app' });
}

/** Daily digest. Implemented in Prompt 5. */
export async function digestDaily() {
  await audit({ actorAccountId: null, actorKind: 'monitor', action: 'digest.tick', target: 'app' });
}

interface IssueEvent {
  eventType: string;
  issue?: { key?: string; fields?: { issuetype?: { name?: string } } };
  atlassianId?: string;
}

/** Jira issue events → incremental monitor (Prompt 5). For now: record only Foreman issue types. */
export async function issueEvents(event: IssueEvent) {
  const type = event.issue?.fields?.issuetype?.name;
  const tracked = ['Permit', 'Inspection', 'RFI', 'Punch Item', 'Code Finding'];
  if (!type || !tracked.includes(type)) return;
  await audit({
    actorAccountId: event.atlassianId ?? null,
    actorKind: 'system',
    action: 'jira.event',
    target: event.issue?.key ?? null,
    after: { eventType: event.eventType, type },
  });
}
