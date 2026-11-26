import { jira, route } from '../lib/jira';
import {
  DEMO_PROJECT_KEY,
  DEMO_PROJECT_NAME,
  ISSUE_TYPES,
  ISSUE_TYPE_DESCRIPTIONS,
  IssueTypeName,
  LINK_TYPES,
  LinkKind,
} from '../seed/dataset';

/**
 * Idempotent Jira configuration for Foreman: issue types, issue type scheme, link types,
 * a dedicated screen / screen scheme / issue type screen scheme, and the demo project.
 * Every ensure* looks up by name first and only creates what is missing, so it is safe to rerun.
 * These calls need Jira admin, so they run asUser from resolvers.
 */

export const NAMES = {
  issueTypeScheme: 'Foreman Construction Issue Types',
  screen: 'Foreman Construction Screen',
  screenScheme: 'Foreman Construction Screen Scheme',
  issueTypeScreenScheme: 'Foreman Construction Issue Type Screen Scheme',
};

/** Forge custom field module keys (manifest `jira:customField`). */
export const FIELD_KEYS = {
  trade: 'foreman-trade',
  level: 'foreman-level',
  permitNo: 'foreman-permit-no',
  jurisdiction: 'foreman-jurisdiction',
  risk: 'foreman-risk',
  stage: 'foreman-stage',
} as const;
export type FieldName = keyof typeof FIELD_KEYS;

interface IssueType {
  id: string;
  name: string;
  subtask?: boolean;
  scope?: unknown;
}

export async function assertJiraAdmin(): Promise<void> {
  const res = await jira<{ permissions: Record<string, { havePermission: boolean }> }>(
    route`/rest/api/3/mypermissions?permissions=ADMINISTER`,
    { as: 'user' },
  );
  if (!res.permissions.ADMINISTER?.havePermission) {
    throw new Error('Loading the demo project needs Jira administrator permission (it creates issue types and a project).');
  }
}

export async function ensureIssueTypes(): Promise<Record<IssueTypeName, string>> {
  const existing = await jira<IssueType[]>(route`/rest/api/3/issuetype`, { as: 'user' });
  const out = {} as Record<IssueTypeName, string>;
  for (const name of ISSUE_TYPES) {
    // Global (company-managed) types only; team-managed types carry a project scope.
    const found = existing.find((t) => t.name === name && !t.subtask && !t.scope);
    if (found) {
      out[name] = found.id;
      continue;
    }
    const created = await jira<IssueType>(route`/rest/api/3/issuetype`, {
      as: 'user',
      method: 'POST',
      body: { name, description: ISSUE_TYPE_DESCRIPTIONS[name], hierarchyLevel: 0 },
    });
    out[name] = created.id;
  }
  return out;
}

export async function ensureIssueTypeScheme(typeIds: Record<IssueTypeName, string>): Promise<string> {
  const page = await jira<{ values: { id: string; name: string }[] }>(
    route`/rest/api/3/issuetypescheme?maxResults=50&queryString=${NAMES.issueTypeScheme}`,
    { as: 'user' },
  );
  const found = page.values.find((s) => s.name === NAMES.issueTypeScheme);
  const ids = ISSUE_TYPES.map((n) => typeIds[n]);
  if (found) {
    // Make sure all our types are in it (adding an existing type is rejected, so diff first).
    const items = await jira<{ values: { issueTypeId: string }[] }>(
      route`/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${found.id}&maxResults=50`,
      { as: 'user' },
    );
    const have = new Set(items.values.map((v) => v.issueTypeId));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
      await jira(route`/rest/api/3/issuetypescheme/${found.id}/issuetype`, {
        as: 'user',
        method: 'PUT',
        body: { issueTypeIds: missing },
      });
    }
    return found.id;
  }
  const created = await jira<{ issueTypeSchemeId: string }>(route`/rest/api/3/issuetypescheme`, {
    as: 'user',
    method: 'POST',
    body: {
      name: NAMES.issueTypeScheme,
      description: 'Permits, inspections, RFIs, punch items and code findings (Foreman).',
      issueTypeIds: ids,
      defaultIssueTypeId: typeIds.Inspection,
    },
  });
  return created.issueTypeSchemeId;
}

interface LinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export async function ensureLinkTypes(): Promise<Record<LinkKind, string>> {
  const { issueLinkTypes } = await jira<{ issueLinkTypes: LinkType[] }>(route`/rest/api/3/issueLinkType`, { as: 'user' });
  const out = {} as Record<LinkKind, string>;
  for (const [kind, def] of Object.entries(LINK_TYPES) as [LinkKind, (typeof LINK_TYPES)[LinkKind]][]) {
    const found = issueLinkTypes.find((l) => l.name.toLowerCase() === def.name.toLowerCase());
    if (found) {
      out[kind] = found.name;
      continue;
    }
    const created = await jira<LinkType>(route`/rest/api/3/issueLinkType`, {
      as: 'user',
      method: 'POST',
      body: { name: def.name, inward: def.inward, outward: def.outward },
    });
    out[kind] = created.name;
  }
  return out;
}

interface Field {
  id: string;
  name: string;
  schema?: { custom?: string };
}

/**
 * Resolve Forge custom field ids by module key (schema.custom ends with `/static/<moduleKey>`).
 * Forge fields are not returned by GET /field; they only show up in the paginated /field/search.
 */
export async function getForemanFieldIds(as: 'user' | 'app' = 'app'): Promise<Partial<Record<FieldName, string>>> {
  const fields: Field[] = [];
  for (let startAt = 0; startAt < 1000; startAt += 100) {
    const page = await jira<{ values: Field[]; isLast?: boolean; total?: number }>(
      route`/rest/api/3/field/search?type=custom&maxResults=100&startAt=${startAt}`,
      { as },
    );
    fields.push(...page.values);
    if (page.isLast || page.values.length < 100) break;
  }
  const out: Partial<Record<FieldName, string>> = {};
  for (const [name, key] of Object.entries(FIELD_KEYS) as [FieldName, string][]) {
    const f = fields.find((x) => x.schema?.custom?.startsWith('ari:cloud:ecosystem') && x.schema.custom.endsWith(`/static/${key}`));
    if (f) out[name] = f.id;
  }
  return out;
}

const SYSTEM_SCREEN_FIELDS = ['summary', 'issuetype', 'description', 'duedate', 'labels', 'assignee', 'reporter', 'priority', 'attachment', 'issuelinks'];

/** Dedicated screen -> screen scheme -> issue type screen scheme, so we never touch global defaults. */
export async function ensureScreens(fieldIds: Partial<Record<FieldName, string>>): Promise<string> {
  // Screen
  const screens = await jira<{ values: { id: number; name: string }[] }>(
    route`/rest/api/3/screens?maxResults=50&queryString=${NAMES.screen}`,
    { as: 'user' },
  );
  let screenId = screens.values.find((s) => s.name === NAMES.screen)?.id;
  if (!screenId) {
    const s = await jira<{ id: number }>(route`/rest/api/3/screens`, {
      as: 'user',
      method: 'POST',
      body: { name: NAMES.screen, description: 'Foreman construction fields.' },
    });
    screenId = s.id;
  }
  // Tab + fields
  const tabs = await jira<{ id: number; name: string }[]>(route`/rest/api/3/screens/${screenId}/tabs`, { as: 'user' });
  let tabId = tabs[0]?.id;
  if (!tabId) {
    const t = await jira<{ id: number }>(route`/rest/api/3/screens/${screenId}/tabs`, {
      as: 'user',
      method: 'POST',
      body: { name: 'Construction' },
    });
    tabId = t.id;
  }
  const onTab = await jira<{ id: string }[]>(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields`, { as: 'user' });
  const present = new Set(onTab.map((f) => f.id));
  const wanted = [...SYSTEM_SCREEN_FIELDS, ...Object.values(fieldIds).filter(Boolean)] as string[];
  for (const fieldId of wanted) {
    if (present.has(fieldId)) continue;
    await jira(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields`, {
      as: 'user',
      method: 'POST',
      body: { fieldId },
      allow: [400], // field not placeable on screens (e.g. not available) - skip, non-fatal
    });
  }

  // Screen scheme
  const schemes = await jira<{ values: { id: number; name: string }[] }>(
    route`/rest/api/3/screenscheme?maxResults=50&queryString=${NAMES.screenScheme}`,
    { as: 'user' },
  );
  let screenSchemeId = schemes.values.find((s) => s.name === NAMES.screenScheme)?.id;
  if (!screenSchemeId) {
    const s = await jira<{ id: number }>(route`/rest/api/3/screenscheme`, {
      as: 'user',
      method: 'POST',
      body: { name: NAMES.screenScheme, screens: { default: screenId } },
    });
    screenSchemeId = s.id;
  }

  // Issue type screen scheme
  const itss = await jira<{ values: { id: string; name: string }[] }>(
    route`/rest/api/3/issuetypescreenscheme?maxResults=50&queryString=${NAMES.issueTypeScreenScheme}`,
    { as: 'user' },
  );
  let itssId = itss.values.find((s) => s.name === NAMES.issueTypeScreenScheme)?.id;
  if (!itssId) {
    const s = await jira<{ id: string }>(route`/rest/api/3/issuetypescreenscheme`, {
      as: 'user',
      method: 'POST',
      body: {
        name: NAMES.issueTypeScreenScheme,
        issueTypeMappings: [{ issueTypeId: 'default', screenSchemeId: String(screenSchemeId) }],
      },
    });
    itssId = s.id;
  }
  return String(itssId);
}

interface Project {
  id: string;
  key: string;
  name: string;
}

export async function findProject(key = DEMO_PROJECT_KEY): Promise<Project | null> {
  return jira<Project | null>(route`/rest/api/3/project/${key}`, { as: 'user', allow: [404] });
}

export async function isForemanProject(key: string): Promise<boolean> {
  const prop = await jira<{ value?: { foreman?: boolean } } | null>(route`/rest/api/3/project/${key}/properties/foreman`, {
    as: 'user',
    allow: [404],
  });
  return Boolean(prop?.value?.foreman);
}

export async function ensureProject(opts: { issueTypeSchemeId: string; issueTypeScreenSchemeId: string; demoVersion: number }): Promise<Project> {
  const existing = await findProject();
  if (existing) {
    if (!(await isForemanProject(existing.key))) {
      throw new Error(
        `A project with key ${DEMO_PROJECT_KEY} already exists and was not created by Foreman. Rename or delete it, then load the demo again.`,
      );
    }
    await assignSchemes(existing.id, opts);
    return existing;
  }
  const me = await jira<{ accountId: string }>(route`/rest/api/3/myself`, { as: 'user' });
  const created = await jira<{ id: number; key: string }>(route`/rest/api/3/project`, {
    as: 'user',
    method: 'POST',
    body: {
      key: DEMO_PROJECT_KEY,
      name: DEMO_PROJECT_NAME,
      description: 'Foreman demo: a 5-story mixed-use project (retail podium + 4 levels residential). Safe to reset from the Foreman Command Center.',
      leadAccountId: me.accountId,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
      assigneeType: 'UNASSIGNED',
    },
  });
  // Jira rejects a template together with explicit schemes, so assign them after creation.
  await assignSchemes(String(created.id), opts);
  await jira(route`/rest/api/3/project/${created.key}/properties/foreman`, {
    as: 'user',
    method: 'PUT',
    body: { foreman: true, demoVersion: opts.demoVersion, createdAt: new Date().toISOString() },
  });
  return { id: String(created.id), key: created.key, name: DEMO_PROJECT_NAME };
}

/** Point the project at Foreman's issue type scheme and screens (idempotent). */
async function assignSchemes(projectId: string, opts: { issueTypeSchemeId: string; issueTypeScreenSchemeId: string }) {
  const current = await jira<{ values: { issueTypeScheme: { id: string } }[] }>(
    route`/rest/api/3/issuetypescheme/project?projectId=${projectId}`,
    { as: 'user' },
  );
  if (current.values[0]?.issueTypeScheme.id !== opts.issueTypeSchemeId) {
    await jira(route`/rest/api/3/issuetypescheme/project`, {
      as: 'user',
      method: 'PUT',
      body: { issueTypeSchemeId: opts.issueTypeSchemeId, projectId },
    });
  }
  const screens = await jira<{ values: { issueTypeScreenScheme: { id: string } }[] }>(
    route`/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`,
    { as: 'user' },
  );
  if (screens.values[0]?.issueTypeScreenScheme.id !== opts.issueTypeScreenSchemeId) {
    await jira(route`/rest/api/3/issuetypescreenscheme/project`, {
      as: 'user',
      method: 'PUT',
      body: { issueTypeScreenSchemeId: opts.issueTypeScreenSchemeId, projectId },
    });
  }
}
