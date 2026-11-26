import { kvs } from '@forge/kvs';
import { audit } from '../lib/audit';
import { exec, query } from '../lib/db';
import { adf, jira, mapLimit, route } from '../lib/jira';
import {
  buildIssues,
  BuiltIssue,
  DEMO_LABEL,
  DEMO_PROJECT_KEY,
  DEMO_VERSION,
  FIELD_NOTES,
  IssueTypeName,
  LINKS,
  LinkKind,
  noteTimestamp,
  PARTIES,
  partyName,
  PLAN_SHEETS,
  PROJECT_META,
  seedLabel,
  stageCategory,
} from '../seed/dataset';
import { demoPhoto } from '../seed/photos';
import {
  assertJiraAdmin,
  ensureIssueTypes,
  ensureIssueTypeScheme,
  ensureLinkTypes,
  ensureProject,
  ensureScreens,
  FieldName,
  findProject,
  getForemanFieldIds,
  isForemanProject,
} from './jiraConfig';

/**
 * "Load demo project": an idempotent, resumable sequence of steps, each short enough for the
 * 25 s resolver limit. The UI calls runDemoStep() for each pending step and shows progress.
 * Rerunning a finished step is a no-op; rerunning a half-finished one completes it.
 */

export const DEMO_STEPS = [
  { id: 'config', label: 'Create issue types, link types and screens' },
  { id: 'project', label: 'Create the Riverside Commons project' },
  { id: 'issues', label: 'Create permits, inspections, RFIs and punch items' },
  { id: 'workflow', label: 'Set issue statuses' },
  { id: 'links', label: 'Link inspection sequence, permits and blockers' },
  { id: 'evidence', label: 'Add plan sheets, field notes and photos' },
  { id: 'finalize', label: 'Finish' },
] as const;
export type DemoStepId = (typeof DEMO_STEPS)[number]['id'];

export interface DemoState {
  version: number;
  projectKey: string;
  projectId?: string;
  seedDate: string;
  completed: DemoStepId[];
  typeIds?: Record<IssueTypeName, string>;
  issueTypeSchemeId?: string;
  issueTypeScreenSchemeId?: string;
  linkTypes?: Record<LinkKind, string>;
  fieldIds?: Partial<Record<FieldName, string>>;
  issues?: Record<string, { key: string; id: string }>;
  loadedAt?: string;
}

const STATE_KEY = `demo:${DEMO_PROJECT_KEY}`;

export async function getDemoState(): Promise<DemoState | null> {
  return ((await kvs.get(STATE_KEY)) as DemoState | undefined) ?? null;
}

async function saveState(s: DemoState) {
  await kvs.set(STATE_KEY, s);
}

function freshState(): DemoState {
  return { version: DEMO_VERSION, projectKey: DEMO_PROJECT_KEY, seedDate: new Date().toISOString(), completed: [] };
}

function markDone(s: DemoState, step: DemoStepId) {
  if (!s.completed.includes(step)) s.completed.push(step);
}

export interface DemoStatus {
  projectKey: string;
  loaded: boolean;
  completed: DemoStepId[];
  steps: { id: DemoStepId; label: string; done: boolean }[];
  issueCount: number;
  loadedAt?: string;
}

export async function demoStatus(): Promise<DemoStatus> {
  const s = await getDemoState();
  const completed = s?.completed ?? [];
  return {
    projectKey: DEMO_PROJECT_KEY,
    loaded: completed.includes('finalize'),
    completed,
    steps: DEMO_STEPS.map((st) => ({ ...st, done: completed.includes(st.id) })),
    issueCount: Object.keys(s?.issues ?? {}).length,
    loadedAt: s?.loadedAt,
  };
}

// ---------------- steps ----------------

async function stepConfig(s: DemoState): Promise<string> {
  await assertJiraAdmin();
  s.typeIds = await ensureIssueTypes();
  s.issueTypeSchemeId = await ensureIssueTypeScheme(s.typeIds);
  s.linkTypes = await ensureLinkTypes();
  s.fieldIds = await getForemanFieldIds('user');
  s.issueTypeScreenSchemeId = await ensureScreens(s.fieldIds);
  const missing = (['trade', 'level', 'permitNo', 'jurisdiction', 'risk', 'stage'] as FieldName[]).filter((f) => !s.fieldIds?.[f]);
  return missing.length ? `Configured. Fields not found yet: ${missing.join(', ')}` : 'Issue types, link types and screens ready';
}

async function stepProject(s: DemoState): Promise<string> {
  if (!s.issueTypeSchemeId) throw new Error('config step must run first');
  // Fields can appear a little after install; refresh them and make sure they are on the screen.
  const fieldIds = await getForemanFieldIds('user');
  if (Object.keys(fieldIds).length) s.fieldIds = fieldIds;
  s.issueTypeScreenSchemeId = await ensureScreens(s.fieldIds ?? {});
  const p = await ensureProject({
    issueTypeSchemeId: s.issueTypeSchemeId,
    issueTypeScreenSchemeId: s.issueTypeScreenSchemeId!,
    demoVersion: DEMO_VERSION,
  });
  s.projectId = p.id;
  s.projectKey = p.key;
  return `Project ${p.key} ready`;
}

interface SearchIssue {
  id: string;
  key: string;
  fields: {
    labels?: string[];
    status?: { statusCategory?: { key: string } };
    issuelinks?: { type: { name: string }; outwardIssue?: { key: string }; inwardIssue?: { key: string } }[];
  };
}

async function findDemoIssues(fields: string[]): Promise<Map<string, SearchIssue>> {
  const res = await jira<{ issues: SearchIssue[] }>(route`/rest/api/3/search/jql`, {
    as: 'user',
    method: 'POST',
    body: { jql: `project = ${DEMO_PROJECT_KEY} AND labels = ${DEMO_LABEL} ORDER BY created ASC`, fields: ['labels', ...fields], maxResults: 100 },
  });
  const bySeed = new Map<string, SearchIssue>();
  for (const iss of res.issues) {
    const tag = iss.fields.labels?.find((l) => l.startsWith('foreman-seed-'));
    if (tag) bySeed.set(tag.slice('foreman-seed-'.length).toUpperCase(), iss);
  }
  return bySeed;
}

/** Entity property stored on every seeded issue; read by monitor, agent and UI. */
export function foremanProperty(i: BuiltIssue) {
  return {
    seedId: i.seedId,
    kind: i.type,
    stage: i.stage,
    trade: i.trade,
    level: i.level,
    permitNo: i.permitNo ?? null,
    permitSeed: i.permit ?? null,
    contractor: partyName(i.contractor) ?? null,
    inspector: partyName(i.inspector) ?? null,
    ...i.dates,
    assignment: i.assignment
      ? { contractor: partyName(i.assignment.contractor), assignedAt: i.assignmentAt, acknowledgedAt: i.assignment.acknowledged ? i.assignmentAt : null }
      : null,
    checklist: i.checklist ?? [],
    sheets: i.sheets ?? [],
    demo: true,
  };
}

function descriptionFor(i: BuiltIssue): ReturnType<typeof adf> {
  const lines = [i.description, ''];
  if (i.contractor) lines.push(`Contractor: ${partyName(i.contractor)}`);
  if (i.inspector) lines.push(`Inspector: ${partyName(i.inspector)}`);
  if (i.dates.submittedOn) lines.push(`Submitted: ${i.dates.submittedOn}`);
  if (i.dates.expiresOn) lines.push(`Expires: ${i.dates.expiresOn}`);
  if (i.checklist?.length) lines.push(`Checklist: ${i.checklist.join('; ')}`);
  if (i.sheets?.length) lines.push(`Plan sheets: ${i.sheets.join(', ')}`);
  lines.push('', 'Sample data created by Foreman "Load demo project".');
  return adf(...lines);
}

async function stepIssues(s: DemoState): Promise<string> {
  if (!s.projectId || !s.typeIds) throw new Error('project step must run first');
  const built = buildIssues(new Date(s.seedDate));
  // Known issues = saved state (authoritative right after create) + search (survives lost state).
  // Search is eventually consistent, so never rely on it alone for idempotency.
  const known: Record<string, { key: string; id: string }> = { ...(s.issues ?? {}) };
  for (const [seed, iss] of await findDemoIssues([])) known[seed] ??= { key: iss.key, id: iss.id };
  const toCreate = built.filter((i) => !known[i.seedId]);

  if (toCreate.length) {
    const res = await jira<{ issues: { id: string; key: string }[]; errors: { failedElementNumber: number; elementErrors: unknown }[] }>(
      route`/rest/api/3/issue/bulk`,
      {
        as: 'user',
        method: 'POST',
        body: {
          issueUpdates: toCreate.map((i) => ({
            fields: {
              project: { id: s.projectId },
              issuetype: { id: s.typeIds![i.type] },
              summary: i.summary,
              description: descriptionFor(i),
              labels: i.labels,
              ...(i.type === 'Inspection' && i.dates.scheduledFor ? { duedate: i.dates.scheduledFor } : {}),
              ...(i.type === 'Permit' && i.dates.expiresOn ? { duedate: i.dates.expiresOn } : {}),
            },
            properties: [{ key: 'foreman', value: foremanProperty(i) }],
          })),
        },
      },
    );
    // Successful elements come back in input order, skipping failed element numbers.
    const failed = new Set((res.errors ?? []).map((e) => e.failedElementNumber));
    let n = 0;
    toCreate.forEach((i, idx) => {
      if (failed.has(idx)) return;
      const created = res.issues[n++];
      if (created) known[i.seedId] = { key: created.key, id: created.id };
    });
    s.issues = known;
    await saveState(s); // persist before anything else can fail
    if (res.errors?.length) {
      throw new Error(`Jira rejected ${res.errors.length} demo issue(s): ${JSON.stringify(res.errors[0]).slice(0, 400)}`);
    }
  }

  s.issues = known;
  const missing = built.filter((i) => !s.issues![i.seedId]).map((i) => i.seedId);
  if (missing.length) throw new Error(`Demo issues missing after create: ${missing.join(', ')}`);

  await setFieldValues(s, built);
  return `${built.length} work items ready (${toCreate.length} created)`;
}

/** Forge custom field values are app-owned: write them asApp via the app field value API. */
async function setFieldValues(s: DemoState, built: BuiltIssue[]) {
  const fieldIds = s.fieldIds?.trade ? s.fieldIds : (s.fieldIds = await getForemanFieldIds('app'));
  const groups = new Map<string, { customField: string; issueIds: number[]; value: unknown }>();
  const add = (field: FieldName, value: unknown, issueId: string) => {
    const id = fieldIds[field];
    if (!id || value === undefined || value === null) return;
    const k = `${id}|${JSON.stringify(value)}`;
    const g = groups.get(k) ?? { customField: id, issueIds: [], value };
    g.issueIds.push(Number(issueId));
    groups.set(k, g);
  };
  const permitNoBySeed = Object.fromEntries(built.filter((b) => b.type === 'Permit').map((b) => [b.seedId, b.permitNo]));
  for (const i of built) {
    const id = s.issues![i.seedId].id;
    add('trade', i.trade, id);
    add('level', i.level, id);
    add('stage', i.stage, id);
    add('permitNo', i.permitNo ?? (i.permit ? permitNoBySeed[i.permit] : undefined), id);
    add('jurisdiction', i.jurisdiction ?? (i.type === 'Permit' || i.type === 'Inspection' ? PROJECT_META.jurisdiction : undefined), id);
  }
  const updates = [...groups.values()];
  for (let i = 0; i < updates.length; i += 50) {
    await jira(route`/rest/api/3/app/field/value`, { as: 'app', method: 'POST', body: { updates: updates.slice(i, i + 50) } });
  }
}

interface Transition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

async function stepWorkflow(s: DemoState): Promise<string> {
  if (!s.issues) throw new Error('issues step must run first');
  const built = buildIssues(new Date(s.seedDate));
  let moved = 0;
  await mapLimit(built, 6, async (i) => {
    const want = stageCategory(i.stage);
    if (want === 'new') return;
    const key = s.issues![i.seedId].key;
    const iss = await jira<{ fields: { status: { statusCategory: { key: string } } } }>(route`/rest/api/3/issue/${key}?fields=status`, {
      as: 'user',
    });
    if (iss.fields.status.statusCategory.key === want) return;
    const { transitions } = await jira<{ transitions: Transition[] }>(route`/rest/api/3/issue/${key}/transitions`, { as: 'user' });
    const candidates = transitions.filter((t) => t.to.statusCategory.key === want);
    const pick = candidates.find((t) => /progress/i.test(t.to.name)) ?? candidates[0];
    if (!pick) return;
    await jira(route`/rest/api/3/issue/${key}/transitions`, { as: 'user', method: 'POST', body: { transition: { id: pick.id } } });
    moved++;
  });
  return `${moved} statuses updated`;
}

/**
 * Jira's create-link API puts the outward description on `inwardIssue`
 * ("inwardIssue blocks outwardIssue"). Verified on the dev site; see test notes.
 */
export function linkPayload(typeName: string, from: string, to: string) {
  return { type: { name: typeName }, inwardIssue: { key: from }, outwardIssue: { key: to } };
}

async function stepLinks(s: DemoState): Promise<string> {
  if (!s.linkTypes || !s.issues) throw new Error('issues step must run first');
  const existing = new Set<string>();
  const fromKeys = [...new Set(LINKS.map((l) => s.issues![l.from].key))];
  await mapLimit(fromKeys, 6, async (key) => {
    const iss = await jira<SearchIssue>(route`/rest/api/3/issue/${key}?fields=issuelinks`, { as: 'user' });
    for (const l of iss.fields.issuelinks ?? []) {
      if (l.outwardIssue) existing.add(`${l.type.name}|${key}|${l.outwardIssue.key}`);
      if (l.inwardIssue) existing.add(`${l.type.name}|${l.inwardIssue.key}|${key}`);
    }
  });
  let created = 0;
  await mapLimit(LINKS, 6, async (l) => {
    const typeName = s.linkTypes![l.kind];
    const from = s.issues![l.from].key;
    const to = s.issues![l.to].key;
    if (existing.has(`${typeName}|${from}|${to}`)) return;
    await jira(route`/rest/api/3/issueLink`, { as: 'user', method: 'POST', body: linkPayload(typeName, from, to) });
    created++;
  });
  return `${LINKS.length} links ready (${created} created)`;
}

async function stepEvidence(s: DemoState): Promise<string> {
  if (!s.issues) throw new Error('issues step must run first');
  const seedDate = new Date(s.seedDate);

  for (const sheet of PLAN_SHEETS) {
    await exec(
      `INSERT INTO plan_sets (project_key, sheet_id, title, discipline, text, source, seed_tag)
       VALUES (?, ?, ?, ?, ?, 'demo', 'demo')
       ON DUPLICATE KEY UPDATE title = VALUES(title), discipline = VALUES(discipline), text = VALUES(text)`,
      s.projectKey,
      sheet.sheetId,
      sheet.title,
      sheet.discipline,
      sheet.text,
    );
  }

  const done = new Set(
    (await query<{ seed_tag: string }>(`SELECT seed_tag FROM evidence WHERE project_key = ? AND seed_tag IS NOT NULL`, s.projectKey)).map(
      (r) => r.seed_tag,
    ),
  );

  await mapLimit(FIELD_NOTES, 3, async (n, idx) => {
    const issueKey = s.issues![n.issue].key;
    const at = noteTimestamp(seedDate, n.day);
    const noteTag = `note-${idx}`;
    if (!done.has(noteTag)) {
      const heading = n.kind === 'transcript' ? `Voice note transcript - ${n.author}` : `Field note - ${n.author}`;
      const c = await jira<{ id: string }>(route`/rest/api/3/issue/${issueKey}/comment`, {
        as: 'user',
        method: 'POST',
        body: { body: adf(`${heading} (${at.toISOString().slice(0, 16).replace('T', ' ')} UTC)`, n.text) },
      });
      await exec(
        `INSERT INTO evidence (project_key, issue_key, kind, title, text, author, captured_at, comment_id, seed_tag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE comment_id = VALUES(comment_id)`,
        s.projectKey, issueKey, n.kind, heading, n.text, n.author, toSqlTime(at), c.id, noteTag,
      );
    }
    const photoTag = `photo-${idx}`;
    if (n.photo && !done.has(photoTag)) {
      const photo = demoPhoto(n.photo, new Date(at.getTime() - 20 * 60_000));
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(photo.bytes)], { type: 'image/jpeg' }), photo.filename);
      const att = await jira<{ id: string; filename: string }[]>(route`/rest/api/3/issue/${issueKey}/attachments`, {
        as: 'user',
        method: 'POST',
        body: form,
        headers: { 'X-Atlassian-Token': 'no-check' },
      });
      await exec(
        `INSERT INTO evidence (project_key, issue_key, kind, title, author, captured_at, attachment_id, exif_json, seed_tag)
         VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE attachment_id = VALUES(attachment_id)`,
        s.projectKey, issueKey, photo.filename, n.author, toSqlTime(new Date(at.getTime() - 20 * 60_000)), att[0]?.id ?? null,
        JSON.stringify({ DateTimeOriginal: photo.exifDate, Make: 'Foreman Demo', Model: 'SiteCam 2', illustrative: true }),
        photoTag,
      );
    }
  });
  return `${PLAN_SHEETS.length} plan sheets, ${FIELD_NOTES.length} field notes, ${FIELD_NOTES.filter((n) => n.photo).length} photos`;
}

const toSqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

async function stepFinalize(s: DemoState, accountId: string | null): Promise<string> {
  await kvs.set(`project:${s.projectKey}:meta`, { ...PROJECT_META, parties: PARTIES });
  s.loadedAt = new Date().toISOString();
  await audit({
    actorAccountId: accountId,
    actorKind: 'user',
    action: 'demo.loaded',
    target: s.projectKey,
    after: { version: s.version, issues: Object.keys(s.issues ?? {}).length, seedDate: s.seedDate },
  });
  return 'Demo project ready';
}

const RUNNERS: Record<DemoStepId, (s: DemoState, accountId: string | null) => Promise<string>> = {
  config: stepConfig,
  project: stepProject,
  issues: stepIssues,
  workflow: stepWorkflow,
  links: stepLinks,
  evidence: stepEvidence,
  finalize: stepFinalize,
};

/** Run one step (or the next pending one). Returns updated status plus a message. */
export async function runDemoStep(step: DemoStepId | undefined, accountId: string | null): Promise<{ step: DemoStepId | null; message: string; status: DemoStatus }> {
  const s = (await getDemoState()) ?? freshState();
  const target = step ?? DEMO_STEPS.find((st) => !s.completed.includes(st.id))?.id;
  if (!target) return { step: null, message: 'Demo already loaded', status: await demoStatus() };
  const message = await RUNNERS[target](s, accountId);
  markDone(s, target);
  await saveState(s);
  if (target === 'config' || target === 'project') {
    await audit({ actorAccountId: accountId, actorKind: 'user', action: `demo.step.${target}`, target: s.projectKey, after: { message } });
  }
  return { step: target, message, status: await demoStatus() };
}

/**
 * Reset: delete only Foreman-seeded issues (label foreman-demo in the Foreman-owned project),
 * clear demo SQL rows and seed state. Issue types, schemes and the project stay, so the next
 * load is fast. Proposals/evidence for the project are removed; the audit log is kept.
 */
export async function resetDemo(accountId: string | null): Promise<{ deleted: number; remaining: number }> {
  const project = await findProject();
  let deleted = 0;
  if (project) {
    if (!(await isForemanProject(project.key))) throw new Error(`${project.key} was not created by Foreman; refusing to reset it.`);
    const issues = await findDemoIssues([]);
    const keys = [...issues.values()].map((i) => i.key);
    await mapLimit(keys, 6, async (key) => {
      await jira(route`/rest/api/3/issue/${key}?deleteSubtasks=true`, { as: 'user', method: 'DELETE', allow: [404] });
      deleted++;
    });
  }
  await exec(`DELETE FROM evidence WHERE project_key = ?`, DEMO_PROJECT_KEY);
  await exec(`DELETE FROM plan_sets WHERE project_key = ? AND seed_tag = 'demo'`, DEMO_PROJECT_KEY);
  await exec(`DELETE FROM proposals WHERE project_key = ?`, DEMO_PROJECT_KEY);
  const prev = await getDemoState();
  // Keep config ids so the next load skips config/project lookups' creation work.
  const next: DemoState = {
    ...freshState(),
    typeIds: prev?.typeIds,
    issueTypeSchemeId: prev?.issueTypeSchemeId,
    issueTypeScreenSchemeId: prev?.issueTypeScreenSchemeId,
    linkTypes: prev?.linkTypes,
    fieldIds: prev?.fieldIds,
  };
  await saveState(next);
  const remaining = project ? (await findDemoIssues([])).size : 0;
  await audit({ actorAccountId: accountId, actorKind: 'user', action: 'demo.reset', target: DEMO_PROJECT_KEY, after: { deleted, remaining } });
  return { deleted, remaining };
}
