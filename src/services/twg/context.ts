import api from '@forge/api';
import { kvs } from '@forge/kvs';
import { portalRecords } from '../../seed/cityPortal';
import { getConnection } from './connector';

/**
 * Teamwork Graph consumption (asUser; resolvers and Rovo actions only).
 * Uses curated queries, so nothing needs registering:
 *   jiraWorkItemComments       -> who said / decided what on the item and its neighbours
 *   objects(ids)               -> assignee / reporter of those items
 *   atlassianUserContent       -> Confluence pages those people created (specs, decisions)
 *   jiraSpaceWorkItems         -> similar work in the project (precedent)
 * All results are permission-filtered for the current user.
 */

export interface GraphPerson {
  id: string;
  name: string;
  roles: string[];
}
export interface GraphDecision {
  issueKey: string;
  who: string;
  text: string;
  at: string | null;
  url: string | null;
}
export interface GraphDoc {
  title: string;
  url: string | null;
  owner: string;
  score: number;
}
export interface GraphSimilar {
  key: string;
  summary: string;
  status: string | null;
  resolvedAt: string | null;
}
export interface PortalRef {
  recordId: string;
  title: string;
  status: string;
  detail: string;
  official: string;
  date: string;
  project: string;
}
export interface GraphContext {
  available: boolean;
  reason?: string;
  focusKey: string;
  people: GraphPerson[];
  decisions: GraphDecision[];
  docs: GraphDoc[];
  similar: GraphSimilar[];
  portal: PortalRef[];
  connector: { connected: boolean; lastSync: string | null; accepted: number };
  fetchedAt: string;
}

export interface FocusIssue {
  key: string;
  id: string;
  summary: string;
  projectId: string;
  related: { key: string; id: string }[];
  seedId?: string | null;
}

// ---------------- ids ----------------

export async function rememberCloudId(cloudId: string | undefined | null) {
  if (cloudId) await kvs.set('site:cloudId', cloudId);
}
export async function cloudIdOf(explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  return ((await kvs.get('site:cloudId')) as string | undefined) ?? null;
}
export const issueAri = (cloudId: string, issueId: string) => `ari:cloud:jira:${cloudId}:issue/${issueId}`;
export const projectAri = (cloudId: string, projectId: string) => `ari:cloud:jira:${cloudId}:project/${projectId}`;

// ---------------- GraphQL ----------------

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await (api.asUser() as unknown as { requestTeamworkGraph: (q: string, v: unknown) => Promise<Response> }).requestTeamworkGraph(query, variables);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length && !json.data) throw new Error(`Teamwork Graph: ${json.errors[0].message}`);
  return (json.data ?? {}) as T;
}

const COMMENTS = `query foreman_issueComments($id: ID!) {
  jiraWorkItemComments(id: $id, since: "P365D", first: 25) {
    edges { node { __typename ... on JiraWorkItemComment { id content createdAt webUrl author { id name } } } }
  }
}`;
const ITEMS = `query foreman_items($ids: [ID!]!) {
  objects(ids: $ids) { id data { __typename ... on JiraWorkItem { key summary assignee { id name } reporter { id name } status { name } } } }
}`;
const USER_CONTENT = `query foreman_userContent($userId: ID!) {
  atlassianUserContent(userId: $userId, roles: [CREATED], since: "P365D", first: 25) {
    edges { node { __typename ... on ConfluencePage { title webUrl } ... on ConfluenceBlogPost { title webUrl } } }
  }
}`;
const SPACE_ITEMS = `query foreman_spaceItems($spaceAri: ID!) {
  jiraSpaceWorkItems(spaceAri: $spaceAri, first: 25) {
    edges { node { __typename ... on JiraWorkItem { key summary resolvedAt status { name } } } }
  }
}`;

// ---------------- pure helpers (exported for tests) ----------------

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'level', 'levels', 'inspection', 'permit', 'grid', 'riverside', 'commons', 'foreman', 'demo']);
export const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\- ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
export const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((t) => b.has(t)).length;

const DECISION_RE = /\b(decision|decided|approved|approve|accepted|confirmed|rejected|required|must|asi-\d+|per the (architect|engineer)|directive)\b/i;

/** Pull decision statements out of comments; prefers a name written in the text ("Decision (M. Chen ...)"). */
export function extractDecisions(comments: { issueKey: string; author: string; content: string; at: string | null; url: string | null }[]): GraphDecision[] {
  const out: GraphDecision[] = [];
  for (const c of comments) {
    const text = c.content.replace(/\s+/g, ' ').trim();
    if (!text || text.startsWith('[Foreman') || !DECISION_RE.test(text)) continue;
    if (/^(Field note|Voice note transcript)\b/i.test(text)) continue;
    const named = text.match(/^Decision(?: record)?\s*\(([^,)]+)/i)?.[1]?.trim();
    out.push({ issueKey: c.issueKey, who: named ?? c.author, text: text.slice(0, 400), at: c.at, url: c.url });
  }
  return out;
}

export function rankDocs(docs: { title: string; url: string | null; owner: string }[], focusText: string): GraphDoc[] {
  const want = tokens(focusText);
  const seen = new Set<string>();
  return docs
    .filter((d) => d.title && !seen.has(d.title) && seen.add(d.title))
    .map((d) => ({ ...d, score: overlap(tokens(d.title), want) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function rankSimilar(items: GraphSimilar[], focus: { key: string; summary: string }): GraphSimilar[] {
  const want = tokens(focus.summary);
  return items
    .filter((i) => i.key !== focus.key)
    .map((i) => ({ i, s: overlap(tokens(i.summary), want) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.i);
}

/** Portal records that concern this item (by seed id) or that are precedent from other projects. */
export function relevantPortal(seedIds: string[], focusSummary: string, now = new Date()): PortalRef[] {
  const want = tokens(focusSummary);
  return portalRecords()
    .filter((r) => (r.jira && seedIds.includes(r.jira)) || (!r.jira && overlap(tokens(`${r.title} ${r.detail}`), want) > 0))
    .map((r) => ({
      recordId: r.recordId,
      title: r.title,
      status: r.status,
      detail: r.detail,
      official: r.official,
      project: r.project,
      date: new Date(now.getTime() + r.dayOffset * 86_400_000).toISOString().slice(0, 10),
    }));
}

// ---------------- main ----------------

export async function buildGraphContext(focus: FocusIssue, opts: { cloudId?: string | null; relatedSeedIds?: string[] } = {}): Promise<GraphContext> {
  const conn = await getConnection();
  const base: GraphContext = {
    available: false,
    focusKey: focus.key,
    people: [],
    decisions: [],
    docs: [],
    similar: [],
    portal: relevantPortal([focus.seedId, ...(opts.relatedSeedIds ?? [])].filter((x): x is string => !!x), focus.summary),
    connector: { connected: !!conn, lastSync: conn?.lastSync?.at ?? null, accepted: conn?.lastSync?.accepted ?? 0 },
    fetchedAt: new Date().toISOString(),
  };
  const cloudId = await cloudIdOf(opts.cloudId);
  if (!cloudId) return { ...base, reason: 'Site id not known yet; open the Foreman panel once.' };

  try {
    const items = [{ key: focus.key, id: focus.id }, ...focus.related].slice(0, 6);
    const ariToKey = new Map(items.map((i) => [issueAri(cloudId, i.id), i.key]));

    const [commentSets, objects, space] = await Promise.all([
      Promise.all(
        items.map((i) =>
          gql<{ jiraWorkItemComments?: { edges: { node: { content?: string; createdAt?: string; webUrl?: string; author?: { id: string; name?: string } } }[] } }>(COMMENTS, {
            id: issueAri(cloudId, i.id),
          })
            .then((d) => (d.jiraWorkItemComments?.edges ?? []).map((e) => ({ issueKey: i.key, ...e.node })))
            .catch(() => []),
        ),
      ),
      gql<{ objects?: { id: string; data?: { key?: string; summary?: string; assignee?: { id: string; name?: string }; reporter?: { id: string; name?: string } } }[] }>(ITEMS, {
        ids: [...ariToKey.keys()],
      }).catch(() => ({ objects: [] })),
      gql<{ jiraSpaceWorkItems?: { edges: { node: { key?: string; summary?: string; resolvedAt?: string; status?: { name?: string } } }[] } }>(SPACE_ITEMS, {
        spaceAri: projectAri(cloudId, focus.projectId),
      }).catch(() => ({ jiraSpaceWorkItems: { edges: [] } })),
    ]);

    const people = new Map<string, GraphPerson>();
    const addPerson = (u: { id: string; name?: string } | undefined, role: string) => {
      if (!u?.id) return;
      const p = people.get(u.id) ?? { id: u.id, name: u.name ?? 'Unknown', roles: [] };
      if (!p.roles.includes(role)) p.roles.push(role);
      people.set(u.id, p);
    };
    const comments = commentSets.flat();
    for (const c of comments) addPerson(c.author, `commented on ${c.issueKey}`);
    for (const o of objects.objects ?? []) {
      const key = ariToKey.get(o.id) ?? o.data?.key ?? '';
      addPerson(o.data?.assignee, `assignee of ${key}`);
      addPerson(o.data?.reporter, `reporter of ${key}`);
    }

    const decisions = extractDecisions(
      comments.map((c) => ({ issueKey: c.issueKey, author: c.author?.name ?? 'Unknown', content: c.content ?? '', at: c.createdAt ?? null, url: c.webUrl ?? null })),
    );

    const topPeople = [...people.values()].sort((a, b) => b.roles.length - a.roles.length).slice(0, 3);
    const docSets = await Promise.all(
      topPeople.map((p) =>
        gql<{ atlassianUserContent?: { edges: { node: { __typename: string; title?: string; webUrl?: string } }[] } }>(USER_CONTENT, { userId: p.id })
          .then((d) =>
            (d.atlassianUserContent?.edges ?? [])
              .filter((e) => e.node.__typename === 'ConfluencePage' || e.node.__typename === 'ConfluenceBlogPost')
              .map((e) => ({ title: e.node.title ?? '', url: e.node.webUrl ?? null, owner: p.name })),
          )
          .catch(() => []),
      ),
    );
    const focusText = `${focus.summary} ${decisions.map((d) => d.text).join(' ')}`;
    const similar = rankSimilar(
      (space.jiraSpaceWorkItems?.edges ?? []).map((e) => ({ key: e.node.key ?? '', summary: e.node.summary ?? '', status: e.node.status?.name ?? null, resolvedAt: e.node.resolvedAt ?? null })),
      focus,
    );

    return {
      ...base,
      available: true,
      people: [...people.values()],
      decisions,
      docs: rankDocs(docSets.flat(), focusText),
      similar,
    };
  } catch (err) {
    return { ...base, reason: (err as Error).message.slice(0, 200) };
  }
}

/** Compact text block for LLM prompts and agent answers. Pure; exported for tests. */
export function contextAsText(ctx: GraphContext): string {
  const lines: string[] = [];
  if (ctx.decisions.length) lines.push('Decisions on record:', ...ctx.decisions.slice(0, 5).map((d) => `- ${d.who} on ${d.issueKey}${d.at ? ` (${d.at.slice(0, 10)})` : ''}: ${d.text}`));
  if (ctx.people.length) lines.push('People involved:', ...ctx.people.slice(0, 6).map((p) => `- ${p.name}: ${p.roles.slice(0, 3).join(', ')}`));
  if (ctx.docs.length) lines.push('Relevant Confluence docs:', ...ctx.docs.map((d) => `- "${d.title}" (by ${d.owner})`));
  if (ctx.portal.length) lines.push('City permit portal records:', ...ctx.portal.map((r) => `- ${r.date} ${r.recordId} ${r.title}: ${r.status}. ${r.detail} (${r.official}${r.project !== 'Riverside Commons' ? `, ${r.project}` : ''})`));
  if (ctx.similar.length) lines.push('Similar work items:', ...ctx.similar.map((s) => `- ${s.key} ${s.summary} (${s.status ?? 'unknown'})`));
  return lines.join('\n');
}
