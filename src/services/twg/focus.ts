import { kvs } from '@forge/kvs';
import { adf, jira, route } from '../../lib/jira';
import { completeStructured, MODELS } from '../../lib/llm';
import { z } from 'zod';
import { buildGraphContext, contextAsText, FocusIssue, GraphContext } from './context';

/** Build the graph focus for a work item: itself + permit, prerequisites and items that block it. */
export async function focusFor(issueKey: string): Promise<{ focus: FocusIssue; relatedSeedIds: string[] }> {
  const i = await jira<{
    id: string;
    key: string;
    fields: {
      summary: string;
      project: { id: string };
      issuelinks?: { type: { name: string }; outwardIssue?: { id: string; key: string }; inwardIssue?: { id: string; key: string } }[];
    };
    properties?: { foreman?: { seedId?: string } };
  }>(route`/rest/api/3/issue/${issueKey}?fields=summary,project,issuelinks&properties=foreman`, { as: 'user' });
  const links = i.fields.issuelinks ?? [];
  const related = [
    ...links.filter((l) => (l.type.name === 'Governed By Permit' || l.type.name === 'Requires Prior Inspection') && l.outwardIssue).map((l) => l.outwardIssue!),
    ...links.filter((l) => l.type.name === 'Blocks' && l.inwardIssue).map((l) => l.inwardIssue!),
  ].slice(0, 5);
  const relatedProps = await Promise.all(
    related.map((r) =>
      jira<{ properties?: { foreman?: { seedId?: string } } }>(route`/rest/api/3/issue/${r.key}?fields=summary&properties=foreman`, { as: 'user' })
        .then((x) => x.properties?.foreman?.seedId ?? null)
        .catch(() => null),
    ),
  );
  return {
    focus: { key: i.key, id: i.id, summary: i.fields.summary, projectId: i.fields.project.id, related: related.map((r) => ({ key: r.key, id: r.id })), seedId: i.properties?.foreman?.seedId ?? null },
    relatedSeedIds: relatedProps.filter((x): x is string => !!x),
  };
}

export async function issueGraphContext(issueKey: string, cloudId?: string | null): Promise<GraphContext> {
  const { focus, relatedSeedIds } = await focusFor(issueKey);
  return buildGraphContext(focus, { cloudId, relatedSeedIds });
}

/** Short decision notes for LLM prompts (plan review, evidence report). Never throws; bounded time. */
export async function contextNotesFor(issueKey: string, cloudId?: string | null, timeoutMs = 8000): Promise<string[]> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const ctx = await Promise.race([issueGraphContext(issueKey, cloudId).catch(() => null), timeout]);
  if (!ctx) return [];
  return [
    ...ctx.decisions.slice(0, 5).map((d) => `${d.who} on ${d.issueKey}: ${d.text}`),
    ...ctx.portal.filter((p) => p.project === 'Riverside Commons').slice(0, 4).map((p) => `City portal ${p.recordId} (${p.date}): ${p.status}. ${p.detail}`),
  ].map((s) => s.slice(0, 400));
}

// ---------------- briefing: with vs without Teamwork Graph ----------------

const Briefing = z.object({
  headline: z.string(),
  points: z.array(z.string()).max(6),
  nextStep: z.string(),
  talkTo: z.array(z.string()).max(4).default([]),
});
export type Briefing = z.infer<typeof Briefing>;

const BRIEF_SYSTEM = `You brief a construction project manager on one work item in 4-6 short bullet points.
Use ONLY the facts provided. Name people only if they appear in the facts. If the facts do not say who decided
something or what happened before, do not guess. End with one concrete next step. Never say an inspection passed.`;

export async function briefing(issue: { key: string; summary: string; stage: string | null; facts: string[] }, graph: GraphContext | null): Promise<Briefing> {
  const user = [
    `WORK ITEM ${issue.key}: ${issue.summary} (stage: ${issue.stage ?? 'unknown'})`,
    'JIRA + FOREMAN FACTS:',
    ...issue.facts.map((f) => `- ${f}`),
    ...(graph ? ['', 'TEAMWORK GRAPH CONTEXT:', contextAsText(graph) || '(none found)'] : []),
    '',
    'Call write_briefing.',
  ].join('\n');
  const res = await completeStructured({
    schema: Briefing,
    toolName: 'write_briefing',
    toolDescription: 'Write the briefing.',
    system: BRIEF_SYSTEM,
    user,
    model: MODELS.fast,
    maxTokens: 800,
  });
  return res.data;
}

// ---------------- demo graph content ----------------

/** Decision comments and spec pages that give Teamwork Graph something to connect in the demo. */
export const DEMO_DECISIONS: { seedId: string; text: string }[] = [
  { seedId: 'R3', text: 'Decision (M. Chen, City Fire Prevention, site walk): Level 2 east corridor wall type W2 is accepted as UL U419 only if gypsum is installed on BOTH sides before cover. Firestopping submittal required before MEP rough-in.' },
  { seedId: 'I5', text: 'Decision (A. Patel, architect of record): ASI-04 relocates the grid C/4 hold-down to C/4.5 to clear the plumbing chase. Keystone must install it before the framing inspection; RFI-2 to be closed with ASI-04.' },
  { seedId: 'I2', text: 'Decision (S. Okafor, structural engineer of record): bottom mat must be #5 bars @ 12 in. o.c. each way per S-101. No substitution was approved; any #4 @ 18 in. placement requires engineer review before the next pour.' },
  { seedId: 'P3', text: 'Decision (R. Diaz, Northbeam): Volt MEP engineer to resubmit stamped load calculations for panels L2A/L2B by Friday; city confirmed review resumes on resubmittal (portal CR-24020).' },
];

export const DEMO_SPECS: { title: string; body: string; seedIds: string[] }[] = [
  {
    title: 'Riverside Commons - Rated corridor assemblies and firestopping (spec v3)',
    body: '<p>Corridor walls: UL U419, one layer 5/8 in. Type X each side, full height. Wall type W2 equals U419 when both faces are boarded (decision by M. Chen, City Fire Prevention). Penetrations: listed firestop systems per FP-101 schedule (deferred submittal; required before rough-in cover).</p>',
    seedIds: ['R3', 'I5', 'I7'],
  },
  {
    title: 'Riverside Commons - Foundation reinforcement and framing hold-downs (structural notes)',
    body: '<p>Footing bottom mat #5 @ 12 in. o.c. each way, 3 in. clear cover (S-101). No bar substitutions without engineer-of-record approval (S. Okafor). Framing: hold-down at grid C/4 relocated to C/4.5 per ASI-04 (A. Patel).</p>',
    seedIds: ['I2', 'I5'],
  },
];

export async function seedGraphDemoContext(issueKeyBySeed: Record<string, string>, opts: { withConfluence: boolean }): Promise<{ comments: number; pages: number; confluenceError?: string }> {
  const done = ((await kvs.get('demo:graphContext')) as { comments?: string[]; pages?: string[] } | undefined) ?? {};
  const doneComments = new Set(done.comments ?? []);
  let comments = 0;
  for (const d of DEMO_DECISIONS) {
    const key = issueKeyBySeed[d.seedId];
    if (!key || doneComments.has(d.seedId)) continue;
    await jira(route`/rest/api/3/issue/${key}/comment`, { as: 'user', method: 'POST', body: { body: adf(d.text) } });
    doneComments.add(d.seedId);
    comments++;
  }
  let pages = 0;
  let confluenceError: string | undefined;
  const donePages = new Set(done.pages ?? []);
  if (opts.withConfluence) {
    const { createConfluencePage } = await import('../reports');
    for (const s of DEMO_SPECS) {
      if (donePages.has(s.title)) continue;
      try {
        const page = await createConfluencePage(null, s.title, s.body);
        for (const sid of s.seedIds) {
          const key = issueKeyBySeed[sid];
          if (!key) continue;
          await jira(route`/rest/api/3/issue/${key}/remotelink`, {
            as: 'user',
            method: 'POST',
            body: { globalId: `foreman-spec-${page.id}-${key}`, relationship: 'specification', object: { url: page.url, title: s.title } },
          });
        }
        donePages.add(s.title);
        pages++;
      } catch (e) {
        confluenceError = (e as Error).message.slice(0, 200);
        console.warn(`spec page "${s.title}" not created: ${confluenceError}`);
        break;
      }
    }
  }
  await kvs.set('demo:graphContext', { comments: [...doneComments], pages: [...donePages], at: new Date().toISOString() });
  return { comments, pages, ...(confluenceError ? { confluenceError } : {}) };
}
