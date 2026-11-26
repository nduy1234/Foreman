import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { adf, jira } from '../lib/jira';
import { enqueueJob, latestJobForIssue } from '../lib/jobs';
import { commentToEvidence } from '../services/inspectionData';
import { latestReport, listWritableSpaces, publishReport, signOff } from '../services/reports';

/** Field evidence -> verified report resolvers (issue panel "Field evidence" tab). */

type Ctx = { accountId?: string; extension?: { project?: { key?: string }; issue?: { key?: string } } };

function ctxOf(req: { context: unknown }) {
  const c = req.context as Ctx;
  const issueKey = c.extension?.issue?.key;
  const projectKey = c.extension?.project?.key;
  if (!issueKey || !projectKey) throw new Error('Open this panel from a Jira work item.');
  return { accountId: c.accountId ?? null, issueKey, projectKey };
}

function isConsentError(err: unknown): boolean {
  const e = err as { code?: string; name?: string };
  return e?.code === 'NEEDS_AUTHENTICATION_ERR' || e?.name === 'NeedsAuthenticationError';
}

const fail = (err: unknown) => {
  if (isConsentError(err)) throw err;
  return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
};

interface EvidenceIssue {
  fields: {
    comment?: { comments: { id: string; created: string; author?: { displayName?: string }; body: unknown }[] };
    attachment?: { id: string; filename: string; mimeType: string; size: number; created: string }[];
  };
  properties?: { foreman?: { kind?: string; stage?: string; checklist?: string[] } };
}

export function registerEvidenceResolvers(resolver: Resolver) {
  resolver.define('getEvidenceContext', async (req) => {
    const { issueKey } = ctxOf(req);
    const [issueRes, report, job] = await Promise.all([
      api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=comment,attachment&properties=foreman`),
      latestReport(issueKey),
      latestJobForIssue('evidence_report', issueKey),
    ]);
    const issue = issueRes.ok ? ((await issueRes.json()) as EvidenceIssue) : null;
    const notes = (issue?.fields.comment?.comments ?? [])
      .map((c) => commentToEvidence(c as never))
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((e) => ({ id: e.id, kind: e.kind, author: e.author, capturedAt: e.capturedAt, excerpt: (e.text ?? '').slice(0, 280) }));
    const photos = (issue?.fields.attachment ?? [])
      .filter((a) => a.mimeType.startsWith('image/'))
      .map((a) => ({ id: a.id, filename: a.filename, size: a.size, created: a.created }));
    return {
      issueKey,
      stage: issue?.properties?.foreman?.stage ?? null,
      kind: issue?.properties?.foreman?.kind ?? null,
      checklistCount: issue?.properties?.foreman?.checklist?.length ?? 0,
      notes,
      photos,
      report,
      job,
    };
  });

  resolver.define('addFieldNote', async (req) => {
    const ctx = ctxOf(req);
    const { kind, author, text } = z
      .object({ kind: z.enum(['note', 'transcript']), author: z.string().trim().max(80).optional(), text: z.string().trim().min(10).max(10_000) })
      .parse(req.payload);
    const me = await jira<{ displayName: string }>(route`/rest/api/3/myself`, { as: 'user' });
    const who = author || me.displayName;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const heading = `${kind === 'transcript' ? 'Voice note transcript' : 'Field note'} - ${who} (${stamp} UTC)`;
    await jira(route`/rest/api/3/issue/${ctx.issueKey}/comment`, { as: 'user', method: 'POST', body: { body: adf(heading, ...text.split(/\n{2,}/)) } });
    await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: `evidence.${kind}.added`, target: ctx.issueKey, after: { chars: text.length } });
    return { ok: true };
  });

  resolver.define('startEvidenceReport', async (req) => {
    const ctx = ctxOf(req);
    const jobId = await enqueueJob('evidence_report', { projectKey: ctx.projectKey, issueKey: ctx.issueKey, requestedBy: ctx.accountId }, ctx.accountId);
    await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'report.requested', target: ctx.issueKey, after: { jobId } });
    return { jobId };
  });

  resolver.define('listConfluenceSpaces', async () => {
    try {
      return { ok: true as const, spaces: await listWritableSpaces() };
    } catch (err) {
      if (isConsentError(err)) throw err;
      return { ok: false as const, error: 'Confluence is not connected to Foreman on this site. You can still request sign-off in Jira.' };
    }
  });

  resolver.define('publishReport', async (req) => {
    const ctx = ctxOf(req);
    const { reportId, spaceId, skipConfluence } = z
      .object({ reportId: z.number().int(), spaceId: z.string().nullable().default(null), skipConfluence: z.boolean().default(false) })
      .parse(req.payload);
    try {
      const current = await latestReport(ctx.issueKey);
      if (!current || current.id !== reportId) throw new Error('Publish the latest report version for this work item.');
      return { ok: true as const, report: await publishReport(reportId, ctx.accountId, { spaceId, skipConfluence }) };
    } catch (err) {
      return fail(err);
    }
  });

  resolver.define('signOffReport', async (req) => {
    const ctx = ctxOf(req);
    const { reportId, decision, note, acknowledgeConflicts } = z
      .object({
        reportId: z.number().int(),
        decision: z.enum(['approve', 'request_changes']),
        note: z.string().max(1000).optional(),
        acknowledgeConflicts: z.boolean().default(false),
      })
      .parse(req.payload);
    try {
      const current = await latestReport(ctx.issueKey);
      if (!current || current.id !== reportId) throw new Error('Sign off the latest report version for this work item.');
      return { ok: true as const, report: await signOff(reportId, decision, ctx.accountId, note ?? null, acknowledgeConflicts) };
    } catch (err) {
      return fail(err);
    }
  });
}
