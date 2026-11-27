import Resolver from '@forge/resolver';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { enqueueJob, getJob } from '../lib/jobs';
import { DETECTOR_LABELS, DETECTORS } from '../services/monitor/config';
import { buildDigest, latestDigest, storeDigest } from '../services/monitor/digest';
import { getMonitorConfig, getProjectRisk, saveMonitorConfig } from '../services/monitor/store';
import { decideProposal, listProposals } from '../services/proposals';
import { getProjectMeta } from '../services/projectData';
import { buildSnapshot } from '../services/monitor/snapshot';
import { buildHeatmap, buildTimeline } from '../services/visuals';
import { getConnection } from '../services/twg/connector';
import { kvs } from '@forge/kvs';

type Ctx = { accountId?: string; extension?: { project?: { key?: string } } };

function ctxOf(req: { context: unknown }) {
  const c = req.context as Ctx;
  const projectKey = c.extension?.project?.key;
  if (!projectKey) throw new Error('Open the Command Center from a Jira project.');
  return { accountId: c.accountId ?? null, projectKey };
}

const isConsent = (err: unknown) => {
  const e = err as { code?: string; name?: string };
  return e?.code === 'NEEDS_AUTHENTICATION_ERR' || e?.name === 'NeedsAuthenticationError';
};

export function registerMonitorResolvers(resolver: Resolver) {
  resolver.define('getMonitorOverview', async (req) => {
    const { projectKey } = ctxOf(req);
    const meta = await getProjectMeta(projectKey);
    if (!meta) return { monitored: false as const, projectKey };
    const [risk, problems, pending, recent, topRisk, digest, config, lastJob] = await Promise.all([
      getProjectRisk(projectKey),
      query<{ problem_key: string; detector: string; issue_key: string; severity: string; points: number; title: string; why: string; proposal_id: number | null; first_seen: string }>(
        `SELECT problem_key, detector, issue_key, severity, points, title, why, proposal_id, first_seen FROM monitor_problems
         WHERE project_key = ? AND resolved_at IS NULL ORDER BY points DESC LIMIT 50`,
        projectKey,
      ),
      listProposals(projectKey, ['pending']),
      listProposals(projectKey, ['executed', 'rejected', 'failed']),
      query<{ issue_key: string; score: number; band: string; reasons_json: unknown }>(
        `SELECT issue_key, score, band, reasons_json FROM risk_scores WHERE project_key = ? AND score > 0 ORDER BY score DESC LIMIT 10`,
        projectKey,
      ),
      latestDigest(projectKey),
      getMonitorConfig(projectKey),
      query<{ id: number }>(`SELECT id FROM jobs WHERE kind = 'monitor_scan' AND JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.projectKey')) = ? ORDER BY id DESC LIMIT 1`, projectKey),
    ]);
    return {
      monitored: true as const,
      projectKey,
      projectName: meta.name,
      risk,
      problems: problems.map((p) => ({
        key: p.problem_key,
        detector: p.detector,
        detectorLabel: DETECTOR_LABELS[p.detector as keyof typeof DETECTOR_LABELS] ?? p.detector,
        issueKey: p.issue_key,
        severity: p.severity,
        points: Number(p.points),
        title: p.title,
        why: p.why,
        proposalId: p.proposal_id === null ? null : Number(p.proposal_id),
        firstSeen: String(p.first_seen),
      })),
      pending,
      recent: recent.slice(0, 10),
      topRisk: topRisk.map((r) => ({ issueKey: r.issue_key, score: Number(r.score), band: r.band, reasons: (typeof r.reasons_json === 'string' ? JSON.parse(r.reasons_json) : r.reasons_json) as string[] })),
      digest,
      config,
      detectors: DETECTORS.map((d) => ({ id: d, label: DETECTOR_LABELS[d] })),
      lastJob: lastJob[0] ? await getJob(Number(lastJob[0].id)) : null,
    };
  });

  resolver.define('getVisuals', async (req) => {
    const { projectKey } = ctxOf(req);
    const { snapshot } = await buildSnapshot(projectKey);
    const risk = await query<{ issue_key: string; score: number }>(`SELECT issue_key, score FROM risk_scores WHERE project_key = ?`, projectKey);
    const riskByKey = Object.fromEntries(risk.map((r) => [r.issue_key, Number(r.score)]));
    return {
      timeline: buildTimeline(snapshot.issues, snapshot.today),
      heatmap: buildHeatmap(snapshot.issues, riskByKey),
      issues: Object.fromEntries(snapshot.issues.map((i) => [i.key, { summary: i.summary, kind: i.kind, stage: i.stage, risk: riskByKey[i.key] ?? 0 }])),
    };
  });

  /** First-run checklist state across the whole app. */
  resolver.define('getOnboarding', async (req) => {
    const { projectKey } = ctxOf(req);
    const [demo, scans, reports, connector, briefings, dismissed] = await Promise.all([
      kvs.get('demo:FMD') as Promise<{ completed?: string[] } | undefined>,
      query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'monitor.scan'`),
      query<{ n: number }>(`SELECT COUNT(*) AS n FROM inspection_reports`),
      getConnection(),
      query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('action.getProjectRisks','action.reviewPlanAgainstCode','action.requestApproval')`),
      kvs.get(`onboarding:dismissed:${projectKey}`),
    ]);
    return {
      dismissed: !!dismissed,
      steps: {
        demoLoaded: !!demo?.completed?.includes('finalize'),
        monitorRan: Number(scans[0]?.n ?? 0) > 0,
        reportDrafted: Number(reports[0]?.n ?? 0) > 0,
        agentUsed: Number(briefings[0]?.n ?? 0) > 0,
        connectorConnected: !!connector,
      },
    };
  });

  resolver.define('dismissOnboarding', async (req) => {
    const { projectKey } = ctxOf(req);
    await kvs.set(`onboarding:dismissed:${projectKey}`, true);
    return { ok: true };
  });

  resolver.define('runMonitorNow', async (req) => {
    const { projectKey, accountId } = ctxOf(req);
    const { digest } = z.object({ digest: z.boolean().default(false) }).parse(req.payload ?? {});
    const jobId = await enqueueJob('monitor_scan', { projectKey, reason: 'manual', digest }, accountId);
    await audit({ actorAccountId: accountId, actorKind: 'user', action: 'monitor.requested', target: projectKey, after: { jobId, digest } });
    return { jobId };
  });

  resolver.define('decideProposal', async (req) => {
    const { projectKey, accountId } = ctxOf(req);
    const { id, decision, note } = z
      .object({ id: z.number().int(), decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() })
      .parse(req.payload);
    try {
      return { ok: true as const, proposal: await decideProposal(id, decision, accountId, note ?? null, projectKey) };
    } catch (err) {
      if (isConsent(err)) throw err;
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  resolver.define('saveMonitorConfig', async (req) => {
    const { projectKey, accountId } = ctxOf(req);
    const before = await getMonitorConfig(projectKey);
    const saved = await saveMonitorConfig(projectKey, (req.payload as { config?: unknown })?.config);
    await audit({ actorAccountId: accountId, actorKind: 'user', action: 'monitor.config.saved', target: projectKey, before, after: saved });
    return saved;
  });

  resolver.define('previewDigest', async (req) => {
    const { projectKey } = ctxOf(req);
    const d = await buildDigest(projectKey);
    await storeDigest(d);
    return latestDigest(projectKey);
  });
}
