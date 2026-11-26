import { audit } from '../lib/audit';
import { exec, parseJson, query } from '../lib/db';
import { adf, jira, route } from '../lib/jira';
import { enqueueJob } from '../lib/jobs';
import { ProposalKind } from '../lib/schemas';
import { setStage } from './issueStage';
import { latestReport, publishReport } from './reports';

/**
 * Approvable proposals. The monitor and the agent only ever create rows here; a human approves
 * or rejects in the Approval Queue, and only approval executes the action (as that user).
 */

export type ProposalState = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'obsolete';

export interface Proposal {
  id: number;
  projectKey: string;
  kind: ProposalKind;
  targetKey: string | null;
  title: string;
  payload: Record<string, unknown>;
  why: string;
  source: 'monitor' | 'agent' | 'user';
  state: ProposalState;
  dedupeKey: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  result: unknown;
}

interface RawProposal {
  id: number;
  project_key: string;
  kind: ProposalKind;
  target_key: string | null;
  payload_json: unknown;
  why: string;
  source: Proposal['source'];
  state: ProposalState;
  dedupe_key: string | null;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  result_json: unknown;
}

const map = (r: RawProposal): Proposal => {
  const payload = parseJson<Record<string, unknown>>(r.payload_json) ?? {};
  return {
    id: Number(r.id),
    projectKey: r.project_key,
    kind: r.kind,
    targetKey: r.target_key,
    title: String(payload.title ?? r.kind),
    payload,
    why: r.why,
    source: r.source,
    state: r.state,
    dedupeKey: r.dedupe_key,
    createdAt: String(r.created_at),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at ? String(r.decided_at) : null,
    result: parseJson(r.result_json),
  };
};

export async function getProposal(id: number): Promise<Proposal | null> {
  const [r] = await query<RawProposal>(`SELECT * FROM proposals WHERE id = ?`, id);
  return r ? map(r) : null;
}

export async function listProposals(projectKey: string, states: ProposalState[] = ['pending']): Promise<Proposal[]> {
  const rows = await query<RawProposal>(
    `SELECT * FROM proposals WHERE project_key = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 100`,
    projectKey,
    ...states,
  );
  return rows.map(map);
}

/**
 * Create a proposal for a problem, or revive an obsolete one when the problem comes back.
 * A rejected proposal stays rejected (the human already decided). Returns the proposal id.
 */
export async function upsertProposal(p: {
  projectKey: string;
  kind: ProposalKind;
  targetKey: string | null;
  title: string;
  payload: Record<string, unknown>;
  why: string;
  source: Proposal['source'];
  dedupeKey: string;
  createdBy: string | null;
}): Promise<{ id: number; created: boolean }> {
  const [existing] = await query<{ id: number; state: ProposalState }>(`SELECT id, state FROM proposals WHERE dedupe_key = ?`, p.dedupeKey);
  const payload = JSON.stringify({ ...p.payload, title: p.title });
  if (existing) {
    if (existing.state === 'obsolete') {
      await exec(`UPDATE proposals SET state = 'pending', payload_json = ?, why = ?, decided_by = NULL, decided_at = NULL WHERE id = ?`, payload, p.why, existing.id);
      return { id: Number(existing.id), created: true };
    }
    if (existing.state === 'pending') {
      await exec(`UPDATE proposals SET payload_json = ?, why = ? WHERE id = ?`, payload, p.why, existing.id);
    }
    return { id: Number(existing.id), created: false };
  }
  const { insertId } = await exec(
    `INSERT INTO proposals (project_key, kind, target_key, payload_json, why, source, state, dedupe_key, created_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    p.projectKey, p.kind, p.targetKey, payload, p.why, p.source, p.dedupeKey, p.createdBy,
  );
  return { id: insertId, created: true };
}

/** Problem went away on its own: pending proposals for it are no longer needed. */
export async function obsoleteProposals(dedupeKeys: string[]): Promise<number> {
  if (!dedupeKeys.length) return 0;
  const { affectedRows } = await exec(
    `UPDATE proposals SET state = 'obsolete' WHERE state = 'pending' AND dedupe_key IN (${dedupeKeys.map(() => '?').join(',')})`,
    ...dedupeKeys,
  );
  return affectedRows;
}

async function mergeProperty(issueKey: string, patch: Record<string, unknown>) {
  const prop = await jira<{ value: Record<string, unknown> } | null>(route`/rest/api/3/issue/${issueKey}/properties/foreman`, { as: 'user', allow: [404] });
  await jira(route`/rest/api/3/issue/${issueKey}/properties/foreman`, { as: 'user', method: 'PUT', body: { ...(prop?.value ?? {}), ...patch } });
}

const comment = (issueKey: string, ...lines: string[]) =>
  jira(route`/rest/api/3/issue/${issueKey}/comment`, { as: 'user', method: 'POST', body: { body: adf(...lines.filter(Boolean)) } });

/** Execute an approved proposal as the approving user. Returns a short result summary. */
async function execute(p: Proposal, approver: string, accountId: string | null): Promise<Record<string, unknown>> {
  const key = String(p.payload.issueKey ?? p.targetKey ?? '');
  if (!key) throw new Error('Proposal has no target work item');
  switch (p.kind) {
    case 'reschedule': {
      const to = String(p.payload.to);
      await jira(route`/rest/api/3/issue/${key}`, { as: 'user', method: 'PUT', body: { fields: { duedate: to } } });
      await mergeProperty(key, { scheduledFor: to });
      await comment(key, `[Foreman] Rescheduled to ${to} (approved by ${approver}).`, p.payload.reason ? `Reason: ${p.payload.reason}` : '');
      return { rescheduledTo: to };
    }
    case 'notify': {
      await comment(key, `[Foreman] Notice to ${p.payload.to} (approved by ${approver}):`, String(p.payload.message ?? ''));
      await jira(route`/rest/api/3/issue/${key}`, { as: 'user', method: 'PUT', body: { update: { labels: [{ add: 'foreman-notified' }] } } });
      return { notified: p.payload.to };
    }
    case 'escalate': {
      await comment(
        key,
        `[Foreman] Escalation to ${p.payload.to} (approved by ${approver}).`,
        `Subject: ${p.payload.subject ?? ''}`,
        String(p.payload.message ?? ''),
        'Send this through the jurisdiction portal or email; Foreman records that it was approved.',
      );
      await jira(route`/rest/api/3/issue/${key}`, { as: 'user', method: 'PUT', body: { update: { labels: [{ add: 'foreman-escalated' }] } } });
      return { escalatedTo: p.payload.to };
    }
    case 'reinspect': {
      const to = String(p.payload.to);
      await jira(route`/rest/api/3/issue/${key}`, { as: 'user', method: 'PUT', body: { fields: { duedate: to } } });
      await setStage(key, 'Scheduled', { scheduledFor: to, reinspectionReason: p.payload.reason ?? null });
      await comment(key, `[Foreman] Re-inspection booked for ${to} (approved by ${approver}).`, p.payload.reason ? `Why: ${p.payload.reason}` : '');
      return { reinspectionOn: to };
    }
    case 'publish_report': {
      const r = await latestReport(key);
      if (!r) throw new Error(`No draft report for ${key} yet. Generate one in the Field evidence tab first.`);
      if (r.state !== 'draft' && r.state !== 'changes_requested') return { alreadyPublished: r.version, state: r.state };
      try {
        const out = await publishReport(r.id, accountId, { spaceId: null, skipConfluence: false });
        return { publishedVersion: out.version, confluenceUrl: out.confluenceUrl };
      } catch {
        const out = await publishReport(r.id, accountId, { spaceId: null, skipConfluence: true });
        return { publishedVersion: out.version, confluenceUrl: null, note: 'Published in Jira only (Confluence unavailable)' };
      }
    }
    case 'approval_packet': {
      const lines = Array.isArray(p.payload.lines) ? (p.payload.lines as string[]) : [];
      await comment(key, `[Foreman] ${p.payload.packetTitle ?? 'Approval packet'} (approved for the record by ${approver})`, ...lines.slice(0, 80));
      await jira(route`/rest/api/3/issue/${key}`, { as: 'user', method: 'PUT', body: { update: { labels: [{ add: 'foreman-packet-ready' }] } } });
      return { packetPostedOn: key, readiness: p.payload.readiness ?? null };
    }
    default:
      throw new Error(`Proposal kind ${p.kind} cannot be executed from the queue`);
  }
}

export async function decideProposal(id: number, decision: 'approve' | 'reject', accountId: string | null, note: string | null, projectKey: string): Promise<Proposal> {
  const p = await getProposal(id);
  if (!p) throw new Error('Proposal not found');
  if (p.projectKey !== projectKey) throw new Error('Proposal belongs to another project');
  if (p.state !== 'pending') throw new Error(`Proposal is already ${p.state}`);

  if (decision === 'reject') {
    await exec(`UPDATE proposals SET state = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), result_json = ? WHERE id = ?`, accountId, JSON.stringify({ note }), id);
    await audit({ actorAccountId: accountId, actorKind: 'user', action: 'proposal.rejected', target: p.targetKey, proposalId: id, after: { kind: p.kind, note } });
    return (await getProposal(id))!;
  }

  // Claim it first so a double click cannot execute twice.
  const { affectedRows } = await exec(
    `UPDATE proposals SET state = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND state = 'pending'`,
    accountId,
    id,
  );
  if (!affectedRows) throw new Error('Proposal was decided by someone else');
  const me = await jira<{ displayName: string }>(route`/rest/api/3/myself`, { as: 'user' });
  try {
    const result = await execute(p, me.displayName, accountId);
    await exec(`UPDATE proposals SET state = 'executed', result_json = ? WHERE id = ?`, JSON.stringify({ ...result, note }), id);
    await audit({ actorAccountId: accountId, actorKind: 'user', action: 'proposal.approved', target: p.targetKey, proposalId: id, before: { state: 'pending' }, after: { kind: p.kind, result, note } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await exec(`UPDATE proposals SET state = 'failed', result_json = ? WHERE id = ?`, JSON.stringify({ error: message }), id);
    await audit({ actorAccountId: accountId, actorKind: 'user', action: 'proposal.failed', target: p.targetKey, proposalId: id, after: { kind: p.kind, error: message } });
    throw err;
  }
  // Re-check the project so the resolved problem drops off.
  await enqueueJob('monitor_scan', { projectKey, reason: `proposal ${id} executed` }, accountId).catch(() => undefined);
  return (await getProposal(id))!;
}
