import { audit } from '../lib/audit';
import { exec, query } from '../lib/db';
import { adf, jira, route } from '../lib/jira';
import { ReviewResult } from './planReview';
import { getForemanFieldIds } from './jiraConfig';

export type FindingState = 'open' | 'dismissed' | 'approved' | 'ticketed' | 'superseded';

export interface FindingRow {
  id: number;
  projectKey: string;
  issueKey: string;
  sheetId: string;
  jobId: number | null;
  ruleId: string;
  category: string;
  title: string;
  citation: string;
  severity: string;
  status: 'pass' | 'fail' | 'needs_review';
  evidenceQuote: string;
  confidence: number;
  suggestedFix: string | null;
  reasoning: string | null;
  state: FindingState;
  createdIssueKey: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

interface RawFinding {
  id: number;
  project_key: string;
  issue_key: string;
  sheet_id: string;
  job_id: number | null;
  rule_id: string;
  category: string;
  title: string;
  citation: string;
  severity: string;
  status: FindingRow['status'];
  evidence_quote: string;
  confidence: string | number;
  suggested_fix: string | null;
  reasoning: string | null;
  state: FindingState;
  created_issue_key: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const map = (r: RawFinding): FindingRow => ({
  id: Number(r.id),
  projectKey: r.project_key,
  issueKey: r.issue_key,
  sheetId: r.sheet_id,
  jobId: r.job_id === null ? null : Number(r.job_id),
  ruleId: r.rule_id,
  category: r.category,
  title: r.title,
  citation: r.citation,
  severity: r.severity,
  status: r.status,
  evidenceQuote: r.evidence_quote,
  confidence: Number(r.confidence),
  suggestedFix: r.suggested_fix,
  reasoning: r.reasoning,
  state: r.state,
  createdIssueKey: r.created_issue_key,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at ? String(r.decided_at) : null,
  decisionNote: r.decision_note,
  createdAt: String(r.created_at),
});

/**
 * Store a review run. Earlier open findings for the same issue + sheet are superseded;
 * findings a human already acted on (approved, dismissed, ticketed) are kept.
 */
export async function saveReview(projectKey: string, issueKey: string, jobId: number, result: ReviewResult): Promise<number> {
  await exec(
    `UPDATE findings SET state = 'superseded' WHERE issue_key = ? AND sheet_id = ? AND state = 'open'`,
    issueKey,
    result.sheetId,
  );
  for (const f of result.findings) {
    await exec(
      `INSERT INTO findings (project_key, issue_key, sheet_id, job_id, rule_id, category, title, citation, severity, status,
         evidence_quote, confidence, suggested_fix, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectKey, issueKey, result.sheetId, jobId, f.ruleId, f.category, f.title, f.citation, f.severity, f.status,
      f.evidenceQuote, f.confidence, f.suggestedFix || null, f.reasoning || null,
    );
  }
  return result.findings.length;
}

export async function listFindings(issueKey: string): Promise<FindingRow[]> {
  const rows = await query<RawFinding>(
    `SELECT * FROM findings WHERE issue_key = ? AND state <> 'superseded' ORDER BY id ASC LIMIT 200`,
    issueKey,
  );
  return rows.map(map);
}

export async function getFinding(id: number): Promise<FindingRow | null> {
  const [r] = await query<RawFinding>(`SELECT * FROM findings WHERE id = ?`, id);
  return r ? map(r) : null;
}

async function setState(id: number, state: FindingState, accountId: string | null, note: string | null, createdIssueKey?: string) {
  await exec(
    `UPDATE findings SET state = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), decision_note = ?, created_issue_key = COALESCE(?, created_issue_key) WHERE id = ?`,
    state,
    accountId,
    note,
    createdIssueKey ?? null,
    id,
  );
}

async function codeFindingIssueTypeId(projectKey: string): Promise<string> {
  const res = await jira<{ issueTypes?: { id: string; name: string }[]; values?: { id: string; name: string }[] }>(
    route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=50`,
    { as: 'user' },
  );
  const types = res.issueTypes ?? res.values ?? [];
  const t = types.find((x) => x.name === 'Code Finding') ?? types.find((x) => x.name === 'Task') ?? types[0];
  if (!t) throw new Error(`No issue type available in ${projectKey}`);
  return t.id;
}

/** Create a "Code Finding" work item for a finding, linked as blocking the reviewed issue. */
async function createIssueFor(f: FindingRow): Promise<string> {
  const typeId = await codeFindingIssueTypeId(f.projectKey);
  const created = await jira<{ id: string; key: string }>(route`/rest/api/3/issue`, {
    as: 'user',
    method: 'POST',
    body: {
      fields: {
        project: { key: f.projectKey },
        issuetype: { id: typeId },
        summary: `${f.ruleId}: ${f.title} (${f.sheetId})`.slice(0, 250),
        description: adf(
          `Code finding from Foreman plan review of sheet ${f.sheetId}.`,
          `Rule: ${f.ruleId} - ${f.title}`,
          `Citation: ${f.citation}`,
          `Status: ${f.status.replace('_', ' ')} (confidence ${Math.round(f.confidence * 100)}%), severity ${f.severity}`,
          `Evidence from ${f.sheetId}: "${f.evidenceQuote}"`,
          f.reasoning ? `Why: ${f.reasoning}` : '',
          f.suggestedFix ? `Suggested fix: ${f.suggestedFix}` : '',
          `Review guidance for the project team; the building official has final authority.`,
        ),
        labels: ['foreman-code-finding', `foreman-rule-${f.ruleId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`],
      },
    },
  });
  await jira(route`/rest/api/3/issueLink`, {
    as: 'user',
    method: 'POST',
    body: { type: { name: 'Blocks' }, inwardIssue: { key: created.key }, outwardIssue: { key: f.issueKey } },
    allow: [400, 404],
  });
  const fields = await getForemanFieldIds('app').catch(() => ({}) as Record<string, string>);
  const stageField = (fields as Record<string, string>).stage;
  if (stageField) {
    await jira(route`/rest/api/3/app/field/value`, {
      as: 'app',
      method: 'POST',
      body: { updates: [{ customField: stageField, issueIds: [Number(created.id)], value: 'Open' }] },
      allow: [400, 403, 404],
    });
  }
  return created.key;
}

export type FindingAction = 'create_issue' | 'dismiss' | 'approve' | 'reopen';

/** Human decision on a finding. Every action is written to the audit log. */
export async function actOnFinding(
  id: number,
  action: FindingAction,
  accountId: string | null,
  note: string | null,
  expectedIssueKey?: string,
): Promise<FindingRow> {
  const f = await getFinding(id);
  if (!f) throw new Error(`Finding ${id} not found`);
  if (expectedIssueKey && f.issueKey !== expectedIssueKey) throw new Error('Finding belongs to another work item');
  if (f.state === 'superseded') throw new Error('This finding was replaced by a newer review. Refresh the panel.');
  const before = { state: f.state, createdIssueKey: f.createdIssueKey };

  let createdIssueKey: string | undefined;
  switch (action) {
    case 'create_issue':
      if (f.createdIssueKey) throw new Error(`Already tracked as ${f.createdIssueKey}`);
      createdIssueKey = await createIssueFor(f);
      await setState(id, 'ticketed', accountId, note, createdIssueKey);
      break;
    case 'dismiss':
      await setState(id, 'dismissed', accountId, note);
      break;
    case 'approve':
      await setState(id, 'approved', accountId, note);
      break;
    case 'reopen':
      await setState(id, 'open', accountId, note);
      break;
  }
  const after = (await getFinding(id))!;
  await audit({
    actorAccountId: accountId,
    actorKind: 'user',
    action: `finding.${action}`,
    target: f.issueKey,
    before,
    after: { findingId: id, ruleId: f.ruleId, sheetId: f.sheetId, state: after.state, createdIssueKey: after.createdIssueKey, note },
  });
  return after;
}
