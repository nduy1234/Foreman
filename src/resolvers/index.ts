import Resolver from '@forge/resolver';
import { z } from 'zod';
import { listAudit } from '../lib/audit';
import { enqueueJob, getJob } from '../lib/jobs';
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

export const handler = resolver.getDefinitions();
