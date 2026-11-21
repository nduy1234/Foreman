import Resolver from '@forge/resolver';
import { z } from 'zod';
import { listAudit } from '../lib/audit';
import { enqueueJob, getJob } from '../lib/jobs';
import { audit } from '../lib/audit';
import { APP_VERSION } from '../version';

const resolver = new Resolver();

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

export const handler = resolver.getDefinitions();
