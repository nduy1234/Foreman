import { kvs } from '@forge/kvs';
import { audit } from '../../lib/audit';
import { exec, query } from '../../lib/db';
import { adf, jira, mapLimit, route } from '../../lib/jira';
import { getForemanFieldIds } from '../jiraConfig';
import { obsoleteProposals, upsertProposal } from '../proposals';
import { detect, MonitorResult } from './detect';
import { buildSnapshot } from './snapshot';
import { getMonitorConfig, saveProjectRisk } from './store';

/** Labels Foreman owns on monitored work items. */
const RISK_LABELS = ['foreman-risk-high', 'foreman-risk-medium', 'foreman-risk-low'];
const FLAG_PREFIX = 'foreman-flag-';

/** Desired Foreman labels for one issue given its risk band and active detectors. Pure; exported for tests. */
export function desiredLabels(band: 'low' | 'medium' | 'high', detectors: string[], current: string[]): { add: string[]; remove: string[] } {
  const want = new Set<string>([`foreman-risk-${band}`, ...detectors.map((d) => `${FLAG_PREFIX}${d.replace(/_/g, '-')}`)]);
  const ours = current.filter((l) => RISK_LABELS.includes(l) || l.startsWith(FLAG_PREFIX));
  return { add: [...want].filter((l) => !current.includes(l)), remove: ours.filter((l) => !want.has(l)) };
}

export async function runMonitor(projectKey: string, source: string): Promise<MonitorResult & { newProblems: number; resolved: number; proposalsCreated: number }> {
  const cfg = await getMonitorConfig(projectKey);
  const { snapshot, extras } = await buildSnapshot(projectKey);
  const result = detect(snapshot, cfg);

  // ---- problems: open / still open / resolved ----
  const open = await query<{ problem_key: string; commented_at: string | null }>(
    `SELECT problem_key, commented_at FROM monitor_problems WHERE project_key = ? AND resolved_at IS NULL`,
    projectKey,
  );
  const openKeys = new Map(open.map((o) => [o.problem_key, o]));
  const currentKeys = new Set(result.problems.map((p) => p.key));
  let newProblems = 0;
  let proposalsCreated = 0;
  const toComment: typeof result.problems = [];

  for (const p of result.problems) {
    const prop = await upsertProposal({
      projectKey,
      kind: p.proposal.kind,
      targetKey: (p.proposal.payload.issueKey as string) ?? p.issueKey,
      title: p.proposal.title,
      payload: p.proposal.payload,
      why: p.why,
      source: 'monitor',
      dedupeKey: p.key,
      createdBy: null,
    });
    if (prop.created) proposalsCreated++;
    const existing = openKeys.get(p.key);
    if (existing) {
      await exec(
        `UPDATE monitor_problems SET last_seen = CURRENT_TIMESTAMP(3), severity = ?, points = ?, title = ?, why = ?, proposal_id = ? WHERE problem_key = ?`,
        p.severity, p.points, p.title.slice(0, 500), p.why, prop.id, p.key,
      );
      if (!existing.commented_at) toComment.push(p);
    } else {
      newProblems++;
      await exec(
        `INSERT INTO monitor_problems (project_key, problem_key, detector, issue_key, severity, points, title, why, proposal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE resolved_at = NULL, last_seen = CURRENT_TIMESTAMP(3), severity = VALUES(severity), points = VALUES(points),
           title = VALUES(title), why = VALUES(why), proposal_id = VALUES(proposal_id), commented_at = NULL`,
        projectKey, p.key, p.detector, p.issueKey, p.severity, p.points, p.title.slice(0, 500), p.why, prop.id,
      );
      toComment.push(p);
    }
  }
  const resolvedKeys = [...openKeys.keys()].filter((k) => !currentKeys.has(k));
  if (resolvedKeys.length) {
    await exec(
      `UPDATE monitor_problems SET resolved_at = CURRENT_TIMESTAMP(3) WHERE problem_key IN (${resolvedKeys.map(() => '?').join(',')})`,
      ...resolvedKeys,
    );
    await obsoleteProposals(resolvedKeys);
  }

  // ---- risk scores (SQL + read-only Jira field) ----
  for (const r of result.issueRisk) {
    await exec(
      `INSERT INTO risk_scores (issue_key, project_key, score, band, reasons_json, computed_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE score = VALUES(score), band = VALUES(band), reasons_json = VALUES(reasons_json), computed_at = VALUES(computed_at)`,
      r.issueKey, projectKey, r.score, r.band, JSON.stringify(r.reasons.slice(0, 5)),
    );
  }
  const fieldIds = await getForemanFieldIds('app').catch(() => ({}) as Record<string, string>);
  const riskField = (fieldIds as Record<string, string>).risk;
  if (riskField) {
    const groups = new Map<number, number[]>();
    for (const r of result.issueRisk) groups.set(r.score, [...(groups.get(r.score) ?? []), Number(extras.idByIssue[r.issueKey])]);
    const updates = [...groups.entries()].map(([value, issueIds]) => ({ customField: riskField, issueIds, value }));
    for (let i = 0; i < updates.length; i += 50) {
      await jira(route`/rest/api/3/app/field/value`, { as: 'app', method: 'POST', body: { updates: updates.slice(i, i + 50) } });
    }
  }

  // ---- labels (only diffs) ----
  if (cfg.updateLabels) {
    const detectorsByIssue = new Map<string, string[]>();
    for (const p of result.problems) detectorsByIssue.set(p.issueKey, [...new Set([...(detectorsByIssue.get(p.issueKey) ?? []), p.detector])]);
    const changes = result.issueRisk
      .map((r) => ({ key: r.issueKey, ...desiredLabels(r.band, detectorsByIssue.get(r.issueKey) ?? [], extras.labelsByIssue[r.issueKey] ?? []) }))
      .filter((c) => c.add.length || c.remove.length);
    await mapLimit(changes, 5, (c) =>
      jira(route`/rest/api/3/issue/${c.key}`, {
        as: 'app',
        method: 'PUT',
        body: { update: { labels: [...c.add.map((add) => ({ add })), ...c.remove.map((remove) => ({ remove }))] } },
      }),
    );
  }

  // ---- one concise comment per new problem ----
  if (cfg.postComments) {
    await mapLimit(toComment.slice(0, 15), 4, async (p) => {
      await jira(route`/rest/api/3/issue/${p.issueKey}/comment`, {
        as: 'app',
        method: 'POST',
        body: {
          body: adf(
            `[Foreman monitor] ${p.severity.toUpperCase()}: ${p.why}`,
            `Proposed: ${p.proposal.title}. Nothing changes until someone approves it in the Foreman Command Center Approval Queue.`,
          ),
        },
      });
      await exec(`UPDATE monitor_problems SET commented_at = CURRENT_TIMESTAMP(3) WHERE problem_key = ?`, p.key);
    });
  }

  await saveProjectRisk({
    projectKey,
    score: result.project.score,
    band: result.project.band,
    why: result.project.why,
    counts: result.project.counts,
    computedAt: result.computedAt,
    problemCount: result.problems.length,
  });
  await kvs.set(`monitor:lastRun:${projectKey}`, Date.now());
  await audit({
    actorAccountId: null,
    actorKind: 'monitor',
    action: 'monitor.scan',
    target: projectKey,
    after: { source, problems: result.problems.length, newProblems, resolved: resolvedKeys.length, proposalsCreated, projectScore: result.project.score },
  });
  return { ...result, newProblems, resolved: resolvedKeys.length, proposalsCreated };
}
