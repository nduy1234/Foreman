import Resolver from '@forge/resolver';
import { registerEvidenceResolvers } from './evidence';
import { registerMonitorResolvers } from './monitor';
import { registerContextResolvers } from './context';
import { rememberCloudId } from '../services/twg/context';
import { contextNotesFor } from '../services/twg/focus';
import { z } from 'zod';
import { listAudit } from '../lib/audit';
import { enqueueJob, getJob, latestJobForIssue } from '../lib/jobs';
import { ProjectMeta } from '../lib/schemas';
import { RULES, RULE_PACK_VERSION } from '../rules';
import { actOnFinding, listFindings } from '../services/findings';
import { selectRules } from '../services/planReview';
import { getProjectMeta, listPlanSheets, savePlanSheet, saveProjectMeta } from '../services/projectData';
import api, { route } from '@forge/api';
import { audit } from '../lib/audit';
import { APP_VERSION } from '../version';
import { DEMO_STEPS, DemoStepId, demoStatus, resetDemo, runDemoStep } from '../services/demoSeed';

const resolver = new Resolver();

/** Forge's user-consent error must propagate so the platform can show "Allow access". */
function isConsentError(err: unknown): boolean {
  const e = err as { code?: string; name?: string };
  return e?.code === 'NEEDS_AUTHENTICATION_ERR' || e?.name === 'NeedsAuthenticationError';
}

type Ctx = { accountId?: string; extension?: { project?: { key?: string }; issue?: { key?: string } } };

function ctxOf(req: { context: unknown }) {
  const c = req.context as Ctx;
  return {
    accountId: c.accountId ?? null,
    projectKey: c.extension?.project?.key ?? null,
    issueKey: c.extension?.issue?.key ?? null,
  };
}

/** Health/bootstrap info for both UIs. */
resolver.define('getStatus', async (req) => {
  const ctx = ctxOf(req);
  await rememberCloudId((req.context as { cloudId?: string }).cloudId);
  return { ok: true, version: APP_VERSION, ...ctx, serverTime: new Date().toISOString() };
});

/** Round-trip through the async queue to prove consumer + SQL wiring. */
resolver.define('startPingJob', async (req) => {
  const ctx = ctxOf(req);
  const jobId = await enqueueJob('ping', { from: ctx.issueKey ?? ctx.projectKey }, ctx.accountId);
  await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'job.enqueued', target: `job:${jobId}`, after: { kind: 'ping' } });
  return { jobId };
});

resolver.define('getJob', async (req) => {
  const { jobId } = z.object({ jobId: z.number().int() }).parse(req.payload);
  return getJob(jobId);
});

resolver.define('listAudit', async (req) => {
  const { target, limit } = z
    .object({ target: z.string().optional(), limit: z.number().int().optional() })
    .parse(req.payload ?? {});
  return listAudit({ target, limit });
});

// ---- Demo project ----

resolver.define('getDemoStatus', async () => demoStatus());

resolver.define('runDemoStep', async (req) => {
  const ctx = ctxOf(req);
  const { step } = z
    .object({ step: z.enum(DEMO_STEPS.map((s) => s.id) as [DemoStepId, ...DemoStepId[]]).optional() })
    .parse(req.payload ?? {});
  try {
    return { ok: true as const, ...(await runDemoStep(step, ctx.accountId)) };
  } catch (err) {
    if (isConsentError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`demo step ${step ?? '(next)'} failed: ${message}`);
    return { ok: false as const, error: message, status: await demoStatus() };
  }
});

resolver.define('resetDemo', async (req) => {
  const ctx = ctxOf(req);
  z.object({ confirm: z.literal(true) }).parse(req.payload ?? {});
  try {
    return { ok: true as const, ...(await resetDemo(ctx.accountId)), status: await demoStatus() };
  } catch (err) {
    if (isConsentError(err)) throw err;
    return { ok: false as const, error: err instanceof Error ? err.message : String(err), status: await demoStatus() };
  }
});

// ---- Plan review (issue panel) ----

function requireIssue(ctx: ReturnType<typeof ctxOf>) {
  if (!ctx.issueKey || !ctx.projectKey) throw new Error('Open this panel from a Jira work item.');
  return { issueKey: ctx.issueKey, projectKey: ctx.projectKey };
}

interface IssueForReview {
  fields: {
    summary: string;
    issuetype: { name: string };
    attachment?: { id: string; filename: string; mimeType: string; size: number }[];
  };
  properties?: { foreman?: { sheets?: string[] } };
}

resolver.define('getReviewContext', async (req) => {
  const ctx = ctxOf(req);
  const { issueKey, projectKey } = requireIssue(ctx);
  const [meta, sheets, findings, job, issueRes] = await Promise.all([
    getProjectMeta(projectKey),
    listPlanSheets(projectKey),
    listFindings(issueKey),
    latestJobForIssue('plan_review', issueKey),
    api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,issuetype,attachment&properties=foreman`),
  ]);
  const issue = issueRes.ok ? ((await issueRes.json()) as IssueForReview) : null;
  const suggested = issue?.properties?.foreman?.sheets ?? [];
  return {
    issueKey,
    projectKey,
    issueType: issue?.fields.issuetype.name ?? null,
    meta,
    sheets: sheets.map((s) => ({
      sheetId: s.sheetId,
      title: s.title,
      discipline: s.discipline,
      source: s.source,
      suggested: suggested.includes(s.sheetId),
      ruleCount: meta ? selectRules(RULES, meta, s.discipline).length : null,
    })),
    pdfAttachments: (issue?.fields.attachment ?? [])
      .filter((a) => a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'))
      .map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
    findings,
    job,
    rulePack: { version: RULE_PACK_VERSION, total: RULES.length },
  };
});

resolver.define('saveProjectMeta', async (req) => {
  const ctx = ctxOf(req);
  if (!ctx.projectKey) throw new Error('No project in context');
  const { meta } = z.object({ meta: ProjectMeta }).parse(req.payload);
  const saved = await saveProjectMeta(ctx.projectKey, meta);
  await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'project.meta.saved', target: ctx.projectKey, after: saved });
  return saved;
});

const SheetInput = z.object({
  sheetId: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9.\-_ ]+$/),
  title: z.string().trim().min(1).max(255),
  discipline: z.enum(['Architectural', 'Structural', 'Fire Protection', 'MEP', 'Civil']).nullable(),
  text: z.string().trim().min(40, 'Paste at least a few lines of sheet notes').max(200_000),
});

resolver.define('savePlanSheet', async (req) => {
  const ctx = ctxOf(req);
  const { projectKey } = requireIssue(ctx);
  const sheet = SheetInput.parse(req.payload);
  await savePlanSheet(projectKey, { ...sheet, source: 'pasted' });
  await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'plan_sheet.saved', target: ctx.issueKey, after: { sheetId: sheet.sheetId, chars: sheet.text.length } });
  return { ok: true };
});

resolver.define('startPlanReview', async (req) => {
  const ctx = ctxOf(req);
  const { issueKey, projectKey } = requireIssue(ctx);
  const payload = z
    .object({
      sheetIds: z.array(z.string()).max(5).default([]),
      pdf: z
        .object({ attachmentId: z.string(), sheetId: SheetInput.shape.sheetId, title: SheetInput.shape.title, discipline: SheetInput.shape.discipline })
        .optional(),
    })
    .parse(req.payload ?? {});
  if (!payload.sheetIds.length && !payload.pdf) throw new Error('Choose at least one plan sheet');
  if (!(await getProjectMeta(projectKey))) throw new Error('Set the project details first');
  const contextNotes = await contextNotesFor(issueKey, (req.context as { cloudId?: string }).cloudId);
  const jobId = await enqueueJob('plan_review', { projectKey, issueKey, ...payload, requestedBy: ctx.accountId, contextNotes }, ctx.accountId);
  await audit({ actorAccountId: ctx.accountId, actorKind: 'user', action: 'plan_review.requested', target: issueKey, after: { jobId, ...payload } });
  return { jobId };
});

resolver.define('findingAction', async (req) => {
  const ctx = ctxOf(req);
  const { issueKey } = requireIssue(ctx);
  const { id, action, note } = z
    .object({ id: z.number().int(), action: z.enum(['create_issue', 'dismiss', 'approve', 'reopen']), note: z.string().max(500).optional() })
    .parse(req.payload);
  try {
    const finding = await actOnFinding(id, action, ctx.accountId, note ?? null, issueKey);
    return { ok: true as const, finding };
  } catch (err) {
    if (isConsentError(err)) throw err;
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
});

registerEvidenceResolvers(resolver);
registerMonitorResolvers(resolver);
registerContextResolvers(resolver);

export const handler = resolver.getDefinitions();
