import { kvs } from '@forge/kvs';
import { audit } from '../../lib/audit';
import { enqueueJob } from '../../lib/jobs';
import { PortalRecord, portalRecords } from '../../seed/cityPortal';
import { ISSUES } from '../../seed/dataset';

/**
 * Teamwork Graph connector: "City permit portal (demo)". Ingests jurisdiction records
 * (plan-check events, inspection results) as Teamwork Graph work items, associated with the
 * Jira permit/inspection they concern and with the city official who issued them.
 */

export const PORTAL_BASE_URL = 'https://permits.riverside-demo.example';
const CONN_KEY = 'twg:connection';

export interface ConnectionState {
  connectionId: string;
  name: string;
  connectedAt: string;
  lastSync?: { at: string; accepted: number; rejected: number; error?: string };
}

export const getConnection = async () => ((await kvs.get(CONN_KEY)) as ConnectionState | undefined) ?? null;

/** graph:connector onConnectionChange: CREATED / UPDATED / DELETED. */
export async function onConnectionChange(event: { action: 'CREATED' | 'UPDATED' | 'DELETED'; name: string; connectionId: string }) {
  if (event.action === 'DELETED') {
    await kvs.delete(CONN_KEY);
  } else {
    const prev = await getConnection();
    await kvs.set(CONN_KEY, { ...(prev ?? {}), connectionId: event.connectionId, name: event.name, connectedAt: new Date().toISOString() });
    await enqueueJob('twg_sync', { reason: `connection ${event.action.toLowerCase()}` }, null);
  }
  await audit({ actorAccountId: null, actorKind: 'system', action: `twg.connection.${event.action.toLowerCase()}`, target: event.connectionId, after: { name: event.name } });
  return { success: true };
}

const iso = (offsetDays: number, now: Date) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString();

/**
 * Map a portal record to a Teamwork Graph work item. Pure; exported for tests.
 * `issueKeyBySeed` maps demo seed ids (P3, I2...) to the Jira keys created on this site.
 */
export function toGraphObject(r: PortalRecord, issueKeyBySeed: Record<string, string>, now: Date, seq: number) {
  const issueKey = r.jira ? issueKeyBySeed[r.jira] : undefined;
  const at = iso(r.dayOffset, now);
  const official = { externalId: `riverside-${r.official.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`, email: r.officialEmail };
  return {
    schemaVersion: '2.0',
    id: `riverside-portal-${r.recordId}`,
    updateSequenceNumber: seq,
    displayName: `${r.recordId} ${r.title}`,
    description: `${r.status}. ${r.detail} (Permit ${r.permitNo}, ${r.project})`,
    url: `${PORTAL_BASE_URL}/records/${r.recordId}`,
    createdAt: at,
    createdBy: official,
    lastUpdatedAt: at,
    lastUpdatedBy: official,
    permissions: [{ accessControls: [{ principals: [{ type: 'ATLASSIAN_WORKSPACE' as const }] }] }],
    ...(issueKey ? { associations: { lastUpdatedAt: at, updateSequenceNumber: seq, set: [{ associationType: 'issueIdOrKeys', values: [issueKey] }] } } : {}),
    'atlassian:work-item': {
      status: r.status,
      subtype: (r.type === 'plan_check' || r.type === 'permit' ? 'approval' : 'task') as 'approval' | 'task',
      assignee: official,
      workItemProject: { id: r.permitNo, name: `${r.project} - ${r.permitNo}` },
      team: r.type === 'plan_check' ? 'City plan check' : 'City inspections',
    },
  };
}

/** Seed id -> Jira key for the demo project, from the demo state saved by the seeder. */
export async function demoIssueKeys(): Promise<Record<string, string>> {
  const state = (await kvs.get('demo:FMD')) as { issues?: Record<string, { key: string }> } | undefined;
  const out: Record<string, string> = {};
  for (const i of ISSUES) {
    const k = state?.issues?.[i.seedId]?.key;
    if (k) out[i.seedId] = k;
  }
  return out;
}

/** Async job: push all portal records into Teamwork Graph for the active connection. */
export async function syncPortalToGraph(): Promise<{ accepted: number; rejected: number; skipped?: string }> {
  const conn = await getConnection();
  if (!conn) return { accepted: 0, rejected: 0, skipped: 'No Teamwork Graph connection. An admin connects "City permit portal (demo)" in Atlassian Administration > Connected apps.' };
  const { graph } = await import('@forge/teamwork-graph');
  const keys = await demoIssueKeys();
  const now = new Date();
  const seq = Math.floor(now.getTime() / 1000);
  const objects = portalRecords().map((r) => toGraphObject(r, keys, now, seq));
  const res = await graph.setObjects({ objects: objects as never, connectionId: conn.connectionId, properties: { source: 'riverside-portal-demo' } });
  const accepted = res.results?.accepted?.length ?? 0;
  const rejected = res.results?.rejected?.length ?? 0;
  if (!res.success || rejected) console.error(`twg setObjects: success=${res.success} rejected=${JSON.stringify(res.results?.rejected ?? res.error).slice(0, 800)}`);
  await kvs.set(CONN_KEY, { ...conn, lastSync: { at: now.toISOString(), accepted, rejected, ...(res.success ? {} : { error: String(res.error ?? 'failed') }) } });
  await audit({ actorAccountId: null, actorKind: 'system', action: 'twg.sync', target: conn.connectionId, after: { accepted, rejected, success: res.success } });
  return { accepted, rejected };
}
