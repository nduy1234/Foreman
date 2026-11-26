import { audit } from '../../lib/audit';
import { exec, parseJson, query } from '../../lib/db';
import { listProposals } from '../proposals';
import { getProjectRisk } from './store';

export interface Digest {
  projectKey: string;
  date: string;
  risk: { score: number; band: string; why: string } | null;
  newProblems: { issueKey: string; severity: string; title: string }[];
  openProblems: { issueKey: string; severity: string; title: string; ageDays: number }[];
  resolved: { issueKey: string; title: string }[];
  pendingProposals: { id: number; title: string; targetKey: string | null }[];
  decisions: { action: string; target: string | null }[];
}

/** Plain-text digest for people who read it in a comment, email or chat. Pure; exported for tests. */
export function digestText(d: Digest): string {
  const lines = [`Foreman daily digest - ${d.projectKey} - ${d.date}`];
  if (d.risk) lines.push(`Project risk ${d.risk.score}/100 (${d.risk.band}). ${d.risk.why}`);
  lines.push('');
  lines.push(`New since yesterday (${d.newProblems.length}):`);
  for (const p of d.newProblems) lines.push(`  - [${p.severity}] ${p.issueKey}: ${p.title}`);
  lines.push(`Still open (${d.openProblems.length}):`);
  for (const p of d.openProblems.slice(0, 10)) lines.push(`  - [${p.severity}] ${p.issueKey}: ${p.title} (${p.ageDays}d)`);
  lines.push(`Resolved (${d.resolved.length}):`);
  for (const p of d.resolved) lines.push(`  - ${p.issueKey}: ${p.title}`);
  lines.push(`Waiting for approval (${d.pendingProposals.length}):`);
  for (const p of d.pendingProposals.slice(0, 10)) lines.push(`  - #${p.id} ${p.title}`);
  if (d.decisions.length) lines.push(`Decisions in the last 24 h: ${d.decisions.length}`);
  return lines.join('\n');
}

export async function buildDigest(projectKey: string, now = new Date()): Promise<Digest> {
  const date = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 23).replace('T', ' ');
  const [risk, fresh, open, resolved, pending, decisions] = await Promise.all([
    getProjectRisk(projectKey),
    query<{ issue_key: string; severity: string; title: string }>(
      `SELECT issue_key, severity, title FROM monitor_problems WHERE project_key = ? AND resolved_at IS NULL AND first_seen >= ? ORDER BY points DESC`,
      projectKey, since,
    ),
    query<{ issue_key: string; severity: string; title: string; first_seen: string }>(
      `SELECT issue_key, severity, title, first_seen FROM monitor_problems WHERE project_key = ? AND resolved_at IS NULL ORDER BY points DESC`,
      projectKey,
    ),
    query<{ issue_key: string; title: string }>(
      `SELECT issue_key, title FROM monitor_problems WHERE project_key = ? AND resolved_at >= ?`,
      projectKey, since,
    ),
    listProposals(projectKey, ['pending']),
    query<{ action: string; target: string | null }>(
      `SELECT action, target FROM audit_log WHERE action IN ('proposal.approved','proposal.rejected','report.approved','report.changes_requested','finding.create_issue') AND ts >= ?`,
      since,
    ),
  ]);
  return {
    projectKey,
    date,
    risk: risk ? { score: risk.score, band: risk.band, why: risk.why } : null,
    newProblems: fresh.map((p) => ({ issueKey: p.issue_key, severity: p.severity, title: p.title })),
    openProblems: open.map((p) => ({
      issueKey: p.issue_key,
      severity: p.severity,
      title: p.title,
      ageDays: Math.max(0, Math.round((now.getTime() - Date.parse(String(p.first_seen).replace(' ', 'T') + 'Z')) / 86_400_000)),
    })),
    resolved: resolved.map((p) => ({ issueKey: p.issue_key, title: p.title })),
    pendingProposals: pending.map((p) => ({ id: p.id, title: p.title, targetKey: p.targetKey })),
    decisions,
  };
}

export async function storeDigest(d: Digest): Promise<void> {
  await exec(
    `INSERT INTO digests (project_key, digest_date, body_json, text) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE body_json = VALUES(body_json), text = VALUES(text), created_at = CURRENT_TIMESTAMP(3)`,
    d.projectKey, d.date, JSON.stringify(d), digestText(d),
  );
  await audit({ actorAccountId: null, actorKind: 'monitor', action: 'digest.created', target: d.projectKey, after: { date: d.date, open: d.openProblems.length, pending: d.pendingProposals.length } });
}

export async function latestDigest(projectKey: string): Promise<(Digest & { text: string }) | null> {
  const [r] = await query<{ body_json: unknown; text: string }>(
    `SELECT body_json, text FROM digests WHERE project_key = ? ORDER BY digest_date DESC LIMIT 1`,
    projectKey,
  );
  return r ? { ...parseJson<Digest>(r.body_json)!, text: r.text } : null;
}
