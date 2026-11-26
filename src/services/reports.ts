import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { audit } from '../lib/audit';
import { exec, parseJson, query } from '../lib/db';
import { adf, jira } from '../lib/jira';
import { withRetry, HttpError } from '../lib/retry';
import { LineStatus, ReportLine, VerifiedReport } from './inspectionReport';
import { setStage } from './issueStage';

export type ReportState = 'draft' | 'awaiting_signoff' | 'approved' | 'changes_requested';

export interface ReportRow {
  id: number;
  projectKey: string;
  issueKey: string;
  version: number;
  state: ReportState;
  report: VerifiedReport;
  confluencePageId: string | null;
  confluenceUrl: string | null;
  createdAt: string;
  publishedAt: string | null;
  signedBy: string | null;
  signedAt: string | null;
  signoffNote: string | null;
}

interface RawReport {
  id: number;
  project_key: string;
  issue_key: string;
  version: number;
  state: ReportState;
  report_json: unknown;
  confluence_page_id: string | null;
  confluence_url: string | null;
  created_at: string;
  published_at: string | null;
  signed_by: string | null;
  signed_at: string | null;
  signoff_note: string | null;
}

const map = (r: RawReport): ReportRow => ({
  id: Number(r.id),
  projectKey: r.project_key,
  issueKey: r.issue_key,
  version: Number(r.version),
  state: r.state,
  report: parseJson<VerifiedReport>(r.report_json)!,
  confluencePageId: r.confluence_page_id,
  confluenceUrl: r.confluence_url,
  createdAt: String(r.created_at),
  publishedAt: r.published_at ? String(r.published_at) : null,
  signedBy: r.signed_by,
  signedAt: r.signed_at ? String(r.signed_at) : null,
  signoffNote: r.signoff_note,
});

export async function saveReport(projectKey: string, issueKey: string, jobId: number, report: VerifiedReport, createdBy: string | null): Promise<number> {
  const [{ v }] = await query<{ v: number | null }>(`SELECT MAX(version) AS v FROM inspection_reports WHERE issue_key = ?`, issueKey);
  const version = Number(v ?? 0) + 1;
  const { insertId } = await exec(
    `INSERT INTO inspection_reports (project_key, issue_key, version, job_id, state, report_json, verified_count, needs_review_count, conflict_count, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    projectKey, issueKey, version, jobId, JSON.stringify(report), report.counts.verified, report.counts.needs_review, report.counts.conflict, createdBy,
  );
  return insertId;
}

export async function latestReport(issueKey: string): Promise<ReportRow | null> {
  const [r] = await query<RawReport>(`SELECT * FROM inspection_reports WHERE issue_key = ? ORDER BY version DESC LIMIT 1`, issueKey);
  return r ? map(r) : null;
}

export async function getReport(id: number): Promise<ReportRow | null> {
  const [r] = await query<RawReport>(`SELECT * FROM inspection_reports WHERE id = ?`, id);
  return r ? map(r) : null;
}

// ---------------- Confluence ----------------

const SPACE_KEY = 'FRMN';
const SPACE_NAME = 'Foreman Inspection Reports';

async function confluence<T>(path: ReturnType<typeof route>, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return withRetry(async () => {
    const res = await api.asUser().requestConfluence(path, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(`Confluence ${init.method ?? 'GET'} -> ${res.status}: ${text.slice(0, 300)}`, res.status, text);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  });
}

export async function listWritableSpaces(): Promise<{ id: string; key: string; name: string }[]> {
  const res = await confluence<{ results: { id: string; key: string; name: string; type: string }[] }>(
    route`/wiki/api/v2/spaces?limit=50&type=global&status=current`,
  );
  return res.results.map((s) => ({ id: s.id, key: s.key, name: s.name }));
}

/** Resolve the target space: explicit choice, remembered choice, existing FRMN space, or create FRMN. */
async function resolveSpace(preferredSpaceId: string | null): Promise<{ id: string; key: string; baseUrl?: string }> {
  if (preferredSpaceId) {
    await kvs.set('confluence:spaceId', preferredSpaceId);
    const s = await confluence<{ id: string; key: string }>(route`/wiki/api/v2/spaces/${preferredSpaceId}`);
    return { id: s.id, key: s.key };
  }
  const remembered = (await kvs.get('confluence:spaceId')) as string | undefined;
  if (remembered) {
    try {
      const s = await confluence<{ id: string; key: string }>(route`/wiki/api/v2/spaces/${remembered}`);
      return { id: s.id, key: s.key };
    } catch {
      await kvs.delete('confluence:spaceId');
    }
  }
  const found = await confluence<{ results: { id: string; key: string }[] }>(route`/wiki/api/v2/spaces?keys=${SPACE_KEY}`);
  if (found.results[0]) {
    await kvs.set('confluence:spaceId', found.results[0].id);
    return found.results[0];
  }
  const created = await confluence<{ id: string; key: string }>(route`/wiki/api/v2/spaces`, {
    method: 'POST',
    body: { key: SPACE_KEY, name: SPACE_NAME, description: { value: 'Inspection reports published by Foreman.', representation: 'plain' } },
  });
  await kvs.set('confluence:spaceId', created.id);
  return created;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LOZENGE: Record<LineStatus, { colour: string; title: string }> = {
  verified: { colour: 'Green', title: 'VERIFIED' },
  needs_review: { colour: 'Yellow', title: 'NEEDS REVIEW' },
  conflict: { colour: 'Red', title: 'CONFLICT' },
};

const lozenge = (colour: string, title: string) =>
  `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${esc(title)}</ac:parameter></ac:structured-macro>`;

function evidenceHtml(l: ReportLine): string {
  if (!l.evidence.length) return '<em>No linked evidence</em>';
  return (
    '<ul>' +
    l.evidence
      .map((e) => {
        const when = e.capturedAt ? ` (${esc(e.capturedAt.slice(0, 16).replace('T', ' '))} UTC)` : '';
        const q = e.quote ? `: <em>&ldquo;${esc(e.quote)}&rdquo;</em>` : '';
        return `<li><strong>${esc(e.label)}</strong>${when}${q}</li>`;
      })
      .join('') +
    '</ul>'
  );
}

/** Confluence storage-format body for a report. Exported for tests. */
export function renderReportStorage(r: ReportRow, issueUrl: string, signoff?: { decision: string; by: string; at: string; note: string | null }): string {
  const rep = r.report;
  const rec =
    rep.recommendation === 'conflicts_found'
      ? lozenge('Red', 'CONFLICTS FOUND')
      : rep.recommendation === 'needs_review'
        ? lozenge('Yellow', 'NEEDS REVIEW')
        : lozenge('Blue', 'READY FOR SIGN-OFF');
  const rows = rep.lines
    .map(
      (l) =>
        `<tr><td>${lozenge(LOZENGE[l.status].colour, LOZENGE[l.status].title)}</td><td>${esc(l.item)}</td><td>${evidenceHtml(l)}</td><td>${esc(l.rationale)}</td></tr>`,
    )
    .join('');
  const sign = signoff
    ? `<h2>Inspector sign-off</h2><p>${lozenge(signoff.decision === 'approved' ? 'Green' : 'Red', signoff.decision === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED')} by ${esc(signoff.by)} on ${esc(signoff.at.slice(0, 16).replace('T', ' '))} UTC</p>${signoff.note ? `<p>${esc(signoff.note)}</p>` : ''}`
    : `<h2>Inspector sign-off</h2><p>${lozenge('Grey', 'PENDING')} Awaiting inspector decision in Jira. This report does not pass the inspection by itself.</p>`;
  return [
    `<p><strong>Work item:</strong> <a href="${esc(issueUrl)}">${esc(r.issueKey)}</a> &middot; <strong>Report version:</strong> ${r.version} &middot; <strong>Inspection date:</strong> ${esc(rep.inspectionDate)}</p>`,
    `<p>${rec} ${rep.counts.verified} verified &middot; ${rep.counts.needs_review} need review &middot; ${rep.counts.conflict} conflict(s)</p>`,
    `<p>${esc(rep.summary)}</p>`,
    '<h2>Verification</h2>',
    `<table><tbody><tr><th>Status</th><th>Item</th><th>Evidence</th><th>Why</th></tr>${rows}</tbody></table>`,
    rep.observations.length
      ? `<h2>Field observations</h2><ul>${rep.observations.map((o) => `<li><strong>${esc(o.topic)}</strong>: &ldquo;${esc(o.quote)}&rdquo;</li>`).join('')}</ul>`
      : '',
    sign,
    '<p><em>Generated by Foreman from Jira evidence. Every quote is checked against its source; statuses are guidance for the inspector, who has final authority.</em></p>',
  ].join('');
}

async function siteUrl(): Promise<string> {
  const info = await jira<{ baseUrl: string }>(route`/rest/api/3/serverInfo`, { as: 'user' });
  return info.baseUrl;
}

/** Publish the report to Confluence (when connected), link it from the issue, move to Awaiting Sign-off. */
export async function publishReport(
  reportId: number,
  accountId: string | null,
  opts: { spaceId: string | null; skipConfluence: boolean },
): Promise<ReportRow> {
  const r = await getReport(reportId);
  if (!r) throw new Error('Report not found');
  if (r.state !== 'draft' && r.state !== 'changes_requested') throw new Error(`Report v${r.version} is already ${r.state.replace('_', ' ')}`);
  const latest = await latestReport(r.issueKey);
  if (latest && latest.id !== r.id) throw new Error('A newer report version exists; publish that one.');

  const base = await siteUrl();
  const issueUrl = `${base}/browse/${r.issueKey}`;
  let pageId: string | null = r.confluencePageId;
  let pageUrl: string | null = r.confluenceUrl;

  if (!opts.skipConfluence) {
    const space = await resolveSpace(opts.spaceId);
    const title = `${r.issueKey} inspection report v${r.version} - ${r.report.lines.length} items (${new Date().toISOString().slice(0, 10)})`;
    const page = await confluence<{ id: string; _links: { webui: string; base?: string } }>(route`/wiki/api/v2/pages`, {
      method: 'POST',
      body: { spaceId: space.id, status: 'current', title, body: { representation: 'storage', value: renderReportStorage(r, issueUrl) } },
    });
    pageId = page.id;
    pageUrl = `${page._links.base ?? `${base}/wiki`}${page._links.webui}`;
    await jira(route`/rest/api/3/issue/${r.issueKey}/remotelink`, {
      as: 'user',
      method: 'POST',
      body: {
        globalId: `foreman-report-${r.issueKey}-v${r.version}`,
        relationship: 'inspection report',
        object: { url: pageUrl, title: `Inspection report v${r.version} (Confluence)`, summary: r.report.summary.slice(0, 250) },
      },
    });
  }

  await exec(
    `UPDATE inspection_reports SET state = 'awaiting_signoff', confluence_page_id = ?, confluence_url = ?, published_by = ?, published_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    pageId, pageUrl, accountId, r.id,
  );
  await setStage(r.issueKey, 'Awaiting Sign-off', { reportVersion: r.version });
  await jira(route`/rest/api/3/issue/${r.issueKey}/comment`, {
    as: 'user',
    method: 'POST',
    body: {
      body: adf(
        `[Foreman] Inspection report v${r.version} ready for inspector sign-off.`,
        `${r.report.counts.verified} verified, ${r.report.counts.needs_review} need review, ${r.report.counts.conflict} conflict(s).`,
        pageUrl ? `Report: ${pageUrl}` : 'Report is in the Foreman panel on this work item.',
      ),
    },
  });
  await audit({
    actorAccountId: accountId,
    actorKind: 'user',
    action: 'report.published',
    target: r.issueKey,
    after: { reportId: r.id, version: r.version, confluencePageId: pageId, counts: r.report.counts },
  });
  return (await getReport(r.id))!;
}

/**
 * Inspector sign-off. The ONLY path that moves an inspection to Passed.
 * Approving a report with conflicts requires an explicit acknowledgement and a note.
 */
export async function signOff(
  reportId: number,
  decision: 'approve' | 'request_changes',
  accountId: string | null,
  note: string | null,
  acknowledgeConflicts: boolean,
): Promise<ReportRow> {
  const r = await getReport(reportId);
  if (!r) throw new Error('Report not found');
  if (r.state !== 'awaiting_signoff') throw new Error('Only a published report awaiting sign-off can be signed.');
  if (decision === 'request_changes' && !note?.trim()) throw new Error('Say what needs to change.');
  if (decision === 'approve' && r.report.counts.conflict > 0 && (!acknowledgeConflicts || !note?.trim())) {
    throw new Error(`This report has ${r.report.counts.conflict} conflict(s). Acknowledge them and add a note to approve anyway.`);
  }

  const state: ReportState = decision === 'approve' ? 'approved' : 'changes_requested';
  await exec(
    `UPDATE inspection_reports SET state = ?, signed_by = ?, signed_at = CURRENT_TIMESTAMP(3), signoff_note = ? WHERE id = ?`,
    state, accountId, note, r.id,
  );
  const me = await jira<{ displayName: string }>(route`/rest/api/3/myself`, { as: 'user' });
  const at = new Date().toISOString();

  if (decision === 'approve') {
    await setStage(r.issueKey, 'Passed', { inspectedOn: at.slice(0, 10), signedOffBy: accountId, reportVersion: r.version });
  } else {
    await setStage(r.issueKey, 'Scheduled', { changesRequestedAt: at, reportVersion: r.version });
  }

  if (r.confluencePageId) {
    try {
      const page = await confluence<{ title: string; version: { number: number } }>(route`/wiki/api/v2/pages/${r.confluencePageId}`);
      const updated = { ...r, state };
      await confluence(route`/wiki/api/v2/pages/${r.confluencePageId}`, {
        method: 'PUT',
        body: {
          id: r.confluencePageId,
          status: 'current',
          title: page.title,
          version: { number: page.version.number + 1, message: decision === 'approve' ? 'Inspector approved' : 'Inspector requested changes' },
          body: {
            representation: 'storage',
            value: renderReportStorage(updated, `${await siteUrl()}/browse/${r.issueKey}`, { decision: state, by: me.displayName, at, note }),
          },
        },
      });
    } catch (e) {
      console.warn(`Confluence update failed for report ${r.id}: ${(e as Error).message}`);
    }
  }

  await jira(route`/rest/api/3/issue/${r.issueKey}/comment`, {
    as: 'user',
    method: 'POST',
    body: {
      body: adf(
        decision === 'approve'
          ? `[Foreman] ${me.displayName} approved inspection report v${r.version}. Inspection marked Passed.`
          : `[Foreman] ${me.displayName} requested changes to inspection report v${r.version}.`,
        note ? `Note: ${note}` : '',
        r.report.counts.conflict && decision === 'approve' ? `Approved with ${r.report.counts.conflict} acknowledged conflict(s).` : '',
      ),
    },
  });
  await audit({
    actorAccountId: accountId,
    actorKind: 'user',
    action: decision === 'approve' ? 'report.approved' : 'report.changes_requested',
    target: r.issueKey,
    before: { state: r.state },
    after: { reportId: r.id, version: r.version, state, note, acknowledgedConflicts: decision === 'approve' ? r.report.counts.conflict : 0 },
  });
  return (await getReport(r.id))!;
}
