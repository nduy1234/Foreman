import type { AsyncEvent } from '@forge/events';
import { audit } from '../lib/audit';
import { updateJob } from '../lib/jobs';
import { JobEventBody } from '../lib/schemas';
import { runPlanReviewJob } from '../services/planReviewJob';
import { runEvidenceReportJob } from '../services/evidenceReportJob';
import { buildDigest, storeDigest } from '../services/monitor/digest';
import { runMonitor } from '../services/monitor/run';
import { syncPortalToGraph } from '../services/twg/connector';

type JobHandler = (
  input: Record<string, unknown>,
  progress: (pct: number, msg?: string) => Promise<void>,
  jobId: number,
) => Promise<unknown>;

/** Job registry. Later prompts add seed, plan_review, evidence_report, monitor_scan, twg_sync. */
const handlers: Partial<Record<JobEventBody['kind'], JobHandler>> = {
  ping: async (input, progress) => {
    await progress(50, 'pong');
    return { pong: true, echo: input, at: new Date().toISOString() };
  },
  plan_review: (input, progress, jobId) => runPlanReviewJob(jobId, input, progress),
  evidence_report: (input, progress, jobId) => runEvidenceReportJob(jobId, input, progress),
  twg_sync: async () => syncPortalToGraph(),
  monitor_scan: async (input, progress) => {
    const projectKey = String(input.projectKey);
    await progress(10, 'Scanning project');
    const r = await runMonitor(projectKey, String(input.reason ?? 'manual'));
    if (input.digest) {
      await progress(85, 'Writing daily digest');
      await storeDigest(await buildDigest(projectKey));
    }
    const summary = { problems: r.problems.length, newProblems: r.newProblems, resolved: r.resolved, proposalsCreated: r.proposalsCreated, projectScore: r.project.score };
    console.info(`monitor_scan ${projectKey}: ${JSON.stringify({ ...summary, detectors: r.problems.map((p) => `${p.detector}:${p.issueKey}`) })}`);
    return summary;
  },
};

export async function handler(event: AsyncEvent) {
  const body = JobEventBody.parse(event.body);
  const run = handlers[body.kind];
  if (!run) {
    await updateJob(body.jobId, { state: 'failed', error: `no handler for job kind ${body.kind}` });
    return;
  }
  await updateJob(body.jobId, { state: 'running', progress: 1 });
  try {
    const result = await run(body.input, (pct, msg) => updateJob(body.jobId, { progress: pct, message: msg }), body.jobId);
    await updateJob(body.jobId, { state: 'done', progress: 100, result });
    await audit({ actorAccountId: null, actorKind: 'system', action: 'job.done', target: `job:${body.jobId}`, after: { kind: body.kind } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`job ${body.jobId} (${body.kind}) failed: ${message}`);
    await updateJob(body.jobId, { state: 'failed', error: message });
    await audit({ actorAccountId: null, actorKind: 'system', action: 'job.failed', target: `job:${body.jobId}`, after: { kind: body.kind, error: message } });
  }
}
