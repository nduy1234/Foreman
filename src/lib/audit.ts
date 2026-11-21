import { AuditEntry } from './schemas';
import { exec, parseJson, query } from './db';

export interface AuditRow {
  id: number;
  ts: string;
  actorAccountId: string | null;
  actorKind: string;
  action: string;
  target: string | null;
  proposalId: number | null;
  before: unknown;
  after: unknown;
}

/** Clip large JSON so audit rows stay small (SQL row limits, UI payload limits). */
export function clipJson(value: unknown, maxChars = 8000): string | null {
  if (value === undefined) return null;
  const s = JSON.stringify(value);
  if (s.length <= maxChars) return s;
  return JSON.stringify({ truncated: true, preview: s.slice(0, maxChars) });
}

/** The only sanctioned way to write an audit row. */
export async function audit(entry: AuditEntry): Promise<number> {
  const e = AuditEntry.parse(entry);
  const { insertId } = await exec(
    `INSERT INTO audit_log (actor_account_id, actor_kind, action, target, proposal_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    e.actorAccountId,
    e.actorKind,
    e.action,
    e.target,
    e.proposalId,
    clipJson(e.before),
    clipJson(e.after),
  );
  return insertId;
}

interface RawAuditRow {
  id: number;
  ts: string;
  actor_account_id: string | null;
  actor_kind: string;
  action: string;
  target: string | null;
  proposal_id: number | null;
  before_json: unknown;
  after_json: unknown;
}

export async function listAudit(opts: { target?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.target
    ? await query<RawAuditRow>(`SELECT * FROM audit_log WHERE target = ? ORDER BY id DESC LIMIT ${limit}`, opts.target)
    : await query<RawAuditRow>(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${limit}`);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    actorAccountId: r.actor_account_id,
    actorKind: r.actor_kind,
    action: r.action,
    target: r.target,
    proposalId: r.proposal_id === null ? null : Number(r.proposal_id),
    before: parseJson(r.before_json),
    after: parseJson(r.after_json),
  }));
}
