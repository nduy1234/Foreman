import { query } from '../../lib/db';
import { jira, route } from '../../lib/jira';
import { commentToEvidence } from '../inspectionData';
import { getProjectMeta, listPlanSheets } from '../projectData';
import { MonIssue, Snapshot } from './detect';

/** Builds the monitor snapshot for one project (asApp: runs from triggers and the async consumer). */

const TRACKED = ['Permit', 'Inspection', 'RFI', 'Punch Item', 'Code Finding'];

interface SearchIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    issuetype: { name: string };
    status: { statusCategory: { key: string } };
    duedate?: string | null;
    labels?: string[];
    issuelinks?: { type: { name: string }; outwardIssue?: { key: string }; inwardIssue?: { key: string } }[];
    comment?: { comments: { id: string; created: string; author?: { displayName?: string }; body: never }[] };
  };
  properties?: { foreman?: Record<string, unknown> };
}

export interface SnapshotExtras {
  labelsByIssue: Record<string, string[]>;
  idByIssue: Record<string, string>;
}

export async function buildSnapshot(projectKey: string, now = new Date()): Promise<{ snapshot: Snapshot; extras: SnapshotExtras }> {
  const issues: SearchIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jira<{ issues: SearchIssue[]; nextPageToken?: string }>(route`/rest/api/3/search/jql`, {
      as: 'app',
      method: 'POST',
      body: {
        jql: `project = "${projectKey}" AND issuetype in (${TRACKED.map((t) => `"${t}"`).join(', ')}) ORDER BY key ASC`,
        fields: ['summary', 'issuetype', 'status', 'duedate', 'labels', 'issuelinks', 'comment'],
        properties: ['foreman'],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && issues.length < 1000);

  const reports = await query<{ issue_key: string; state: string; conflict_count: number; version: number }>(
    `SELECT r.issue_key, r.state, r.conflict_count, r.version FROM inspection_reports r
     JOIN (SELECT issue_key, MAX(version) AS v FROM inspection_reports WHERE project_key = ? GROUP BY issue_key) m
       ON m.issue_key = r.issue_key AND m.v = r.version`,
    projectKey,
  );
  const reportByIssue = new Map(reports.map((r) => [r.issue_key, { state: r.state, conflicts: Number(r.conflict_count), version: Number(r.version) }]));

  const failRows = await query<{ sheet_id: string; n: number }>(
    `SELECT sheet_id, COUNT(*) AS n FROM findings WHERE project_key = ? AND status = 'fail' AND state IN ('open','approved','ticketed') GROUP BY sheet_id`,
    projectKey,
  );
  const sheets = await listPlanSheets(projectKey, true);
  const meta = await getProjectMeta(projectKey);

  const mon: MonIssue[] = [];
  const notesByIssue: Record<string, string[]> = {};
  const labelsByIssue: Record<string, string[]> = {};
  const idByIssue: Record<string, string> = {};
  for (const i of issues) {
    const p = (i.properties?.foreman ?? {}) as Record<string, unknown>;
    const links = i.fields.issuelinks ?? [];
    const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
    mon.push({
      key: i.key,
      id: i.id,
      kind: i.fields.issuetype.name,
      summary: i.fields.summary,
      stage: str('stage'),
      statusCategory: i.fields.status.statusCategory.key,
      permitNo: str('permitNo'),
      trade: str('trade'),
      level: str('level'),
      scheduledFor: str('scheduledFor') ?? (i.fields.issuetype.name === 'Inspection' ? (i.fields.duedate ?? null) : null),
      submittedOn: str('submittedOn'),
      expiresOn: str('expiresOn'),
      openedOn: str('openedOn'),
      inspectedOn: str('inspectedOn'),
      contractor: str('contractor'),
      inspector: str('inspector'),
      assignment: (p.assignment as MonIssue['assignment']) ?? null,
      requiresPrior: links.filter((l) => l.type.name === 'Requires Prior Inspection' && l.outwardIssue).map((l) => l.outwardIssue!.key),
      governedBy: links.find((l) => l.type.name === 'Governed By Permit' && l.outwardIssue)?.outwardIssue?.key ?? null,
      blocks: links.filter((l) => l.type.name === 'Blocks' && l.outwardIssue).map((l) => l.outwardIssue!.key),
      sheets: Array.isArray(p.sheets) ? (p.sheets as string[]) : [],
      conditions: Array.isArray(p.conditions) ? (p.conditions as string[]) : [],
      latestReport: reportByIssue.get(i.key) ?? null,
    });
    notesByIssue[i.key] = (i.fields.comment?.comments ?? [])
      .map((c) => commentToEvidence(c))
      .filter((e) => e && e.kind !== 'photo')
      .map((e) => e!.text ?? '');
    labelsByIssue[i.key] = i.fields.labels ?? [];
    idByIssue[i.key] = i.id;
  }

  return {
    snapshot: {
      projectKey,
      jurisdiction: meta?.jurisdiction ?? 'the jurisdiction',
      today: now.toISOString().slice(0, 10),
      now: now.toISOString(),
      issues: mon,
      openFailFindingsBySheet: Object.fromEntries(failRows.map((r) => [r.sheet_id, Number(r.n)])),
      notesByIssue,
      planTextBySheet: Object.fromEntries(sheets.map((s) => [s.sheetId, s.text])),
    },
    extras: { labelsByIssue, idByIssue },
  };
}
