import api, { route } from '@forge/api';
import { query } from '../lib/db';
import { jira, mapLimit } from '../lib/jira';
import { ISSUES } from '../seed/dataset';
import { EvidenceItem, InspectionContext } from './inspectionReport';
import { listPlanSheets } from './projectData';

/** Gathers everything the report needs from Jira + Forge SQL. Runs asApp (async consumer). */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** ADF -> plain text, one line per block node. */
export function adfToText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const parts = (node.content ?? []).map(adfToText);
  const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type ?? '');
  return block ? `${parts.join('')}\n` : parts.join(node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList' ? '' : '');
}

const HEADING_RE = /^(Field note|Voice note transcript)\s*-\s*(.+?)\s*\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\)\s*$/i;

/** Classify a Jira comment as field evidence. Foreman's own comments ("[Foreman] ...") are ignored. */
export function commentToEvidence(c: { id: string; created: string; author?: { displayName?: string }; body: AdfNode }): EvidenceItem | null {
  const text = adfToText(c.body).trim();
  if (!text || text.startsWith('[Foreman') || /^Decision(?: record)?\s*\(/i.test(text)) return null;
  const [first, ...rest] = text.split('\n');
  const m = first.match(HEADING_RE);
  if (m) {
    return {
      id: `note-${c.id}`,
      kind: /voice/i.test(m[1]) ? 'transcript' : 'note',
      author: m[2],
      capturedAt: new Date(`${m[3].replace(' ', 'T')}:00Z`).toISOString(),
      text: rest.join('\n').trim() || first,
    };
  }
  return {
    id: `note-${c.id}`,
    kind: /transcript|voice note/i.test(first) ? 'transcript' : 'note',
    author: c.author?.displayName ?? null,
    capturedAt: c.created ? new Date(c.created).toISOString() : null,
    text,
  };
}

interface ForemanProp {
  seedId?: string;
  stage?: string;
  permitNo?: string | null;
  expiresOn?: string | null;
  scheduledFor?: string | null;
  inspectedOn?: string | null;
  contractor?: string | null;
  inspector?: string | null;
  checklist?: string[];
  conditions?: string[];
  sheets?: string[];
}

interface IssueRes {
  id: string;
  key: string;
  fields: {
    summary: string;
    duedate?: string | null;
    comment?: { comments: { id: string; created: string; author?: { displayName?: string }; body: AdfNode }[] };
    attachment?: { id: string; filename: string; mimeType: string; size: number; created: string; author?: { displayName?: string } }[];
    issuelinks?: { type: { name: string }; outwardIssue?: { key: string }; inwardIssue?: { key: string } }[];
  };
  properties?: { foreman?: ForemanProp };
}

async function getIssue(key: string, fields: string): Promise<IssueRes> {
  return jira<IssueRes>(route`/rest/api/3/issue/${key}?fields=${fields}&properties=foreman`, { as: 'app' });
}

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

async function readExif(attachmentId: string): Promise<EvidenceItem['exif']> {
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, { method: 'GET' });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    const exifr = (await import('exifr')).default;
    const tags = (await exifr.parse(buf, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false })) as Record<string, unknown> | undefined;
    if (!tags) return null;
    const dto = tags.DateTimeOriginal ?? tags.CreateDate ?? tags.ModifyDate;
    return {
      dateTimeOriginal: dto instanceof Date && !Number.isNaN(dto.getTime()) ? dto.toISOString() : null,
      lat: typeof tags.latitude === 'number' ? Math.round(tags.latitude * 1e5) / 1e5 : null,
      lon: typeof tags.longitude === 'number' ? Math.round(tags.longitude * 1e5) / 1e5 : null,
      make: typeof tags.Make === 'string' ? tags.Make : null,
      model: typeof tags.Model === 'string' ? tags.Model : null,
    };
  } catch {
    return null;
  }
}

export async function gatherInspection(issueKey: string, projectKey: string): Promise<{ ctx: InspectionContext; evidence: EvidenceItem[] }> {
  const issue = await getIssue(issueKey, 'summary,duedate,comment,attachment,issuelinks');
  const prop = issue.properties?.foreman ?? {};
  const links = issue.fields.issuelinks ?? [];
  const permitKey = links.find((l) => l.type.name === 'Governed By Permit' && l.outwardIssue)?.outwardIssue?.key;
  const priorKeys = links.filter((l) => l.type.name === 'Requires Prior Inspection' && l.outwardIssue).map((l) => l.outwardIssue!.key);

  const [permit, priors] = await Promise.all([
    permitKey ? getIssue(permitKey, 'summary') : Promise.resolve(null),
    mapLimit(priorKeys, 4, (k) => getIssue(k, 'summary')),
  ]);
  const permitProp = permit?.properties?.foreman ?? {};
  const seedConditions = ISSUES.find((i) => i.seedId === permitProp.seedId)?.conditions ?? [];

  const sheetIds = [...new Set([...(prop.sheets ?? []), ...(permitProp.sheets ?? [])])];
  const allSheets = sheetIds.length ? await listPlanSheets(projectKey, true) : [];
  const planSheets = allSheets.filter((s) => sheetIds.includes(s.sheetId)).map((s) => ({ sheetId: s.sheetId, title: s.title, text: s.text }));

  const planFindings = sheetIds.length
    ? (
        await query<{ rule_id: string; title: string; status: string; sheet_id: string; evidence_quote: string }>(
          `SELECT rule_id, title, status, sheet_id, evidence_quote FROM findings
           WHERE project_key = ? AND state IN ('open','approved','ticketed') AND status <> 'pass'
           ORDER BY id DESC LIMIT 40`,
          projectKey,
        )
      )
        .filter((f) => sheetIds.includes(f.sheet_id))
        .slice(0, 15)
        .map((f) => ({ ruleId: f.rule_id, title: f.title, status: f.status, sheetId: f.sheet_id, evidenceQuote: f.evidence_quote }))
    : [];

  const ctx: InspectionContext = {
    issueKey,
    summary: issue.fields.summary,
    stage: prop.stage ?? null,
    scheduledFor: prop.scheduledFor ?? issue.fields.duedate ?? null,
    inspectedOn: prop.inspectedOn ?? null,
    contractor: prop.contractor ?? null,
    inspector: prop.inspector ?? null,
    checklist: prop.checklist ?? [],
    permit: permit
      ? {
          key: permit.key,
          summary: permit.fields.summary,
          stage: permitProp.stage ?? null,
          permitNo: permitProp.permitNo ?? null,
          expiresOn: permitProp.expiresOn ?? null,
          conditions: permitProp.conditions?.length ? permitProp.conditions : seedConditions,
        }
      : null,
    priorInspections: priors.map((p) => ({ key: p.key, summary: p.fields.summary, stage: p.properties?.foreman?.stage ?? null })),
    planSheets,
    planFindings,
  };

  const notes = (issue.fields.comment?.comments ?? []).map(commentToEvidence).filter((e): e is EvidenceItem => !!e);
  const images = (issue.fields.attachment ?? [])
    .filter((a) => a.mimeType.startsWith('image/') && a.size <= MAX_PHOTO_BYTES)
    .slice(0, MAX_PHOTOS);
  const photos: EvidenceItem[] = await mapLimit(images, 3, async (a) => ({
    id: `photo-${a.id}`,
    kind: 'photo' as const,
    author: a.author?.displayName ?? null,
    capturedAt: a.created ? new Date(a.created).toISOString() : null,
    filename: a.filename,
    exif: await readExif(a.id),
  }));
  return { ctx, evidence: [...notes, ...photos] };
}
