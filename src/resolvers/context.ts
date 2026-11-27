import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { jira, route } from '../lib/jira';
import { enqueueJob } from '../lib/jobs';
import { demoIssueKeys, getConnection } from '../services/twg/connector';
import { rememberCloudId } from '../services/twg/context';
import { briefing, issueGraphContext, seedGraphDemoContext } from '../services/twg/focus';

type Ctx = { accountId?: string; cloudId?: string; extension?: { project?: { key?: string }; issue?: { key?: string } } };

function ctxOf(req: { context: unknown }) {
  const c = req.context as Ctx;
  return { accountId: c.accountId ?? null, cloudId: c.cloudId ?? null, issueKey: c.extension?.issue?.key ?? null, projectKey: c.extension?.project?.key ?? null };
}

const isConsent = (err: unknown) => {
  const e = err as { code?: string; name?: string };
  return e?.code === 'NEEDS_AUTHENTICATION_ERR' || e?.name === 'NeedsAuthenticationError';
};

/** Facts Foreman already knows without Teamwork Graph (for the with/without comparison). */
async function localFacts(issueKey: string): Promise<{ summary: string; stage: string | null; facts: string[] }> {
  const i = await jira<{
    fields: { summary: string; duedate?: string | null; issuelinks?: { type: { name: string; outward: string; inward: string }; outwardIssue?: { key: string; fields: { summary: string } }; inwardIssue?: { key: string; fields: { summary: string } } }[] };
    properties?: { foreman?: { stage?: string; contractor?: string; inspector?: string; scheduledFor?: string } };
  }>(route`/rest/api/3/issue/${issueKey}?fields=summary,duedate,issuelinks&properties=foreman`, { as: 'user' });
  const p = i.properties?.foreman ?? {};
  const problems = await query<{ title: string; why: string }>(
    `SELECT title, why FROM monitor_problems WHERE issue_key = ? AND resolved_at IS NULL ORDER BY points DESC LIMIT 4`,
    issueKey,
  );
  return {
    summary: i.fields.summary,
    stage: p.stage ?? null,
    facts: [
      ...(p.scheduledFor ?? i.fields.duedate ? [`Scheduled for ${p.scheduledFor ?? i.fields.duedate}`] : []),
      ...(p.contractor ? [`Contractor: ${p.contractor}`] : []),
      ...(p.inspector ? [`Inspector: ${p.inspector}`] : []),
      ...(i.fields.issuelinks ?? []).slice(0, 6).map((l) => (l.outwardIssue ? `${l.type.outward} ${l.outwardIssue.key} (${l.outwardIssue.fields.summary})` : `${l.type.inward} ${l.inwardIssue!.key} (${l.inwardIssue!.fields.summary})`)),
      ...problems.map((pr) => `Monitor: ${pr.why}`),
    ],
  };
}

export function registerContextResolvers(resolver: Resolver) {
  resolver.define('getIssueContext', async (req) => {
    const ctx = ctxOf(req);
    if (!ctx.issueKey) throw new Error('Open this from a work item.');
    await rememberCloudId(ctx.cloudId);
    const [graph, seeded] = await Promise.all([issueGraphContext(ctx.issueKey, ctx.cloudId), kvs.get('demo:graphContext')]);
    return { issueKey: ctx.issueKey, graph, demoContextSeeded: !!seeded };
  });

  resolver.define('compareBriefing', async (req) => {
    const ctx = ctxOf(req);
    if (!ctx.issueKey) throw new Error('Open this from a work item.');
    try {
      const [facts, graph] = await Promise.all([localFacts(ctx.issueKey), issueGraphContext(ctx.issueKey, ctx.cloudId)]);
      const issue = { key: ctx.issueKey, ...facts };
      const [without, withGraph] = await Promise.all([briefing(issue, null), briefing(issue, graph)]);
      await audit({ actorAccountId: ctx.accountId, actorKind: 'agent', action: 'context.briefing', target: ctx.issueKey, after: { graphAvailable: graph.available, decisions: graph.decisions.length, people: graph.people.length } });
      return { ok: true as const, without, withGraph, graphAvailable: graph.available, reason: graph.reason ?? null };
    } catch (err) {
      if (isConsent(err)) throw err;
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  resolver.define('seedGraphContext', async (req) => {
    const ctx = ctxOf(req);
    const { withConfluence } = z.object({ withConfluence: z.boolean().default(true) }).parse(req.payload ?? {});
    try {
      const keys = await demoIssueKeys();
      if (!Object.keys(keys).length) throw new Error('Load the demo project first.');
      const res = await seedGraphDemoContext(keys, { withConfluence });
      await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'context.demo_seeded', target: 'FMD', after: res });
      return { ok: true as const, ...res, note: 'Teamwork Graph usually indexes new comments and pages within a few minutes.' };
    } catch (err) {
      if (isConsent(err)) throw err;
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  resolver.define('getGraphConnector', async () => {
    const conn = await getConnection();
    return { connected: !!conn, name: conn?.name ?? null, connectedAt: conn?.connectedAt ?? null, lastSync: conn?.lastSync ?? null };
  });

  resolver.define('syncPortalNow', async (req) => {
    const ctx = ctxOf(req);
    const jobId = await enqueueJob('twg_sync', { reason: 'manual' }, ctx.accountId);
    return { jobId };
  });
}
