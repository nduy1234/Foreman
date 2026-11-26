import { z } from 'zod';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { enqueueJob } from '../lib/jobs';
import { RULES } from '../rules';
import { ISSUES } from '../seed/dataset';
import { saveReview } from '../services/findings';
import { DEFAULT_CONFIG } from '../services/monitor/config';
import { detect, MonIssue } from '../services/monitor/detect';
import { buildSnapshot } from '../services/monitor/snapshot';
import { getMonitorConfig, getProjectRisk, monitoredProjects } from '../services/monitor/store';
import { evaluateSheet, selectRules } from '../services/planReview';
import { getPlanSheet, getProjectMeta } from '../services/projectData';
import { decideProposal, getProposal, listProposals, upsertProposal } from '../services/proposals';
import { buildPermitPacket } from './packet';
import { ActionContext, ActionPayload, isoDate, resolveIssueRef, resolveProjectKey, str } from './resolve';

/**
 * Rovo actions (55 s limit each). Read actions return data for the agent to explain.
 * Write actions NEVER change project data: they create proposals that a human approves in the
 * Approval Queue (or explicitly in chat via approvePending, which requires confirmation).
 */

export { resolveProjectKey };

type Result = Record<string, unknown>;

async function projectFor(payload: ActionPayload): Promise<string> {
  const explicit = resolveProjectKey(payload);
  if (explicit) return explicit;
  const monitored = await monitoredProjects();
  if (monitored.length === 1) return monitored[0];
  if (!monitored.length) throw new UserFacing('No Foreman project yet. Open the Foreman Command Center in a Jira project and click "Load demo project".');
  throw new UserFacing(`Which project? Foreman monitors: ${monitored.join(', ')}.`);
}

class UserFacing extends Error {}

/** Wrap an action: audit every call, turn expected errors into a message the agent can relay. */
function action(name: string, fn: (payload: ActionPayload, context: ActionContext) => Promise<Result>) {
  return async (payload: ActionPayload, context: ActionContext): Promise<Result> => {
    const started = Date.now();
    try {
      const out = await fn(payload ?? {}, context ?? {});
      await audit({ actorAccountId: context?.accountId ?? null, actorKind: 'agent', action: `action.${name}`, target: (out.projectKey as string) ?? null, after: { ms: Date.now() - started, inputs: redact(payload) } });
      return out;
    } catch (err) {
      const message = err instanceof UserFacing || err instanceof z.ZodError ? (err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err.message) : 'Foreman could not complete this request.';
      if (!(err instanceof UserFacing) && !(err instanceof z.ZodError)) console.error(`action ${name} failed: ${(err as Error)?.message}`);
      await audit({ actorAccountId: context?.accountId ?? null, actorKind: 'agent', action: `action.${name}.failed`, target: null, after: { error: message } }).catch(() => undefined);
      return { ok: false, error: message };
    }
  };
}

const redact = (p: ActionPayload) => Object.fromEntries(Object.entries(p ?? {}).filter(([k]) => k !== 'context').map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]));

async function loadIssue(projectKey: string, ref: string | undefined, payload: ActionPayload): Promise<{ issue: MonIssue; all: MonIssue[]; snapshot: Awaited<ReturnType<typeof buildSnapshot>>['snapshot'] }> {
  const { snapshot } = await buildSnapshot(projectKey);
  const contextKey = payload.context?.jira?.issueKey;
  const target = ref ?? contextKey;
  if (!target) throw new UserFacing('Which work item? Give a key like FMD-9 or a name like "framing inspection".');
  const issue = resolveIssueRef(target, snapshot.issues);
  if (!issue) throw new UserFacing(`No permit, inspection or RFI in ${projectKey} matches "${target}".`);
  return { issue, all: snapshot.issues, snapshot };
}

const CATEGORY_ALIASES: Record<string, string> = {
  egress: 'egress',
  exits: 'egress',
  fire: 'fire-separation',
  'fire-separation': 'fire-separation',
  'fire separation': 'fire-separation',
  ada: 'accessibility',
  accessibility: 'accessibility',
  structural: 'structural',
  permit: 'permit-prerequisite',
  permits: 'permit-prerequisite',
  'permit-prerequisite': 'permit-prerequisite',
};

// ---------------- 1. reviewPlanAgainstCode ----------------

export const reviewPlanAgainstCode = action('reviewPlanAgainstCode', async (payload, context) => {
  const projectKey = await projectFor(payload);
  const sheetId = str(payload.sheetId, 32)?.toUpperCase();
  if (!sheetId) throw new UserFacing('Which plan sheet? For example A-201.');
  const focusRaw = str(payload.focus, 40)?.toLowerCase();
  const category = focusRaw && focusRaw !== 'all' ? CATEGORY_ALIASES[focusRaw] : undefined;
  if (focusRaw && focusRaw !== 'all' && !category) throw new UserFacing(`Unknown focus "${focusRaw}". Use egress, fire separation, accessibility, structural or permit.`);

  const [meta, sheet] = await Promise.all([getProjectMeta(projectKey), getPlanSheet(projectKey, sheetId)]);
  if (!meta) throw new UserFacing(`Project details for ${projectKey} are not set.`);
  if (!sheet) throw new UserFacing(`Sheet ${sheetId} is not in ${projectKey}. Add it from the Code review tab of a work item.`);
  const rules = selectRules(RULES, meta, sheet.discipline).filter((r) => !category || r.category === category);
  if (!rules.length) return { ok: true, projectKey, sheetId, message: `No ${category ?? ''} rules apply to ${sheetId} (${sheet.discipline}).` };

  // Attach findings to the work item the chat is on, else the first inspection that uses this sheet.
  const { snapshot } = await buildSnapshot(projectKey);
  const owner = payload.context?.jira?.issueKey ?? snapshot.issues.find((i) => i.kind === 'Inspection' && i.sheets.includes(sheetId))?.key ?? snapshot.issues.find((i) => i.sheets.includes(sheetId))?.key ?? `${projectKey}-PLAN`;

  if (rules.length > 12) {
    const jobId = await enqueueJob('plan_review', { projectKey, issueKey: owner, sheetIds: [sheetId], requestedBy: context.accountId ?? null }, context.accountId ?? null);
    return { ok: true, projectKey, sheetId, status: 'queued', jobId, rules: rules.length, message: `Reviewing ${sheetId} against ${rules.length} rules in the background (about a minute). Results appear in the Code review tab of ${owner}. Ask again with a focus such as "egress" for a quick answer.` };
  }

  const deadline = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 42_000));
  const result = await Promise.race([evaluateSheet({ sheetId, title: sheet.title, discipline: sheet.discipline, text: sheet.text }, meta, rules, { batchSize: 6 }), deadline]);
  if (result === 'timeout') {
    const jobId = await enqueueJob('plan_review', { projectKey, issueKey: owner, sheetIds: [sheetId], requestedBy: context.accountId ?? null }, context.accountId ?? null);
    return { ok: true, projectKey, sheetId, status: 'queued', jobId, message: `The review is taking longer than chat allows, so it continues in the background. See the Code review tab on ${owner}.` };
  }
  await saveReview(projectKey, owner, 0, result);
  const fails = result.findings.filter((f) => f.status !== 'pass');
  return {
    ok: true,
    projectKey,
    sheetId,
    status: 'done',
    rulesChecked: result.rulesChecked,
    summary: `${fails.filter((f) => f.status === 'fail').length} fail, ${fails.filter((f) => f.status === 'needs_review').length} need review, ${result.findings.length - fails.length} pass. ${result.rejected.filter((r) => r.reason === 'quote_not_in_source' || r.reason === 'no_evidence').length} unsupported result(s) discarded.`,
    findings: fails.slice(0, 10).map((f) => ({ ruleId: f.ruleId, status: f.status, severity: f.severity, citation: f.citation, evidence: f.evidenceQuote, reasoning: f.reasoning, suggestedFix: f.suggestedFix })),
    passed: result.findings.filter((f) => f.status === 'pass').map((f) => `${f.ruleId} ${f.title}`),
    savedOn: owner,
    note: 'Guidance for the project team; the building official has final authority. Findings can be turned into Jira issues from the Code review tab.',
  };
});

// ---------------- 2. getProjectRisks ----------------

export const getProjectRisks = action('getProjectRisks', async (payload) => {
  const projectKey = await projectFor(payload);
  const cfg = await getMonitorConfig(projectKey).catch(() => DEFAULT_CONFIG);
  const { snapshot } = await buildSnapshot(projectKey);
  const res = detect(snapshot, cfg);
  const focusRef = str(payload.focus, 120) ?? payload.context?.jira?.issueKey;
  const pending = await listProposals(projectKey, ['pending']);
  const stored = await getProjectRisk(projectKey);

  const base = {
    ok: true,
    projectKey,
    projectRisk: { score: res.project.score, band: res.project.band, why: res.project.why },
    lastScheduledScan: stored?.computedAt ?? null,
  };

  if (focusRef) {
    const focus = resolveIssueRef(focusRef, snapshot.issues);
    if (!focus) throw new UserFacing(`Nothing in ${projectKey} matches "${focusRef}".`);
    const byKey = new Map(snapshot.issues.map((i) => [i.key, i]));
    const blockers = [
      ...focus.requiresPrior.map((k) => byKey.get(k)).filter((p): p is MonIssue => !!p && p.stage !== 'Passed').map((p) => `Prerequisite ${p.key} "${p.summary}" is ${p.stage}${p.scheduledFor ? ` (scheduled ${p.scheduledFor})` : ''}.`),
      ...(focus.governedBy && byKey.get(focus.governedBy)?.stage !== 'Approved' ? [`Governing permit ${focus.governedBy} is ${byKey.get(focus.governedBy)?.stage}.`] : []),
      ...snapshot.issues.filter((i) => i.blocks.includes(focus.key) && !['Closed', 'Resolved', 'Answered', 'Passed', 'Approved'].includes(i.stage ?? '')).map((i) => `${i.kind} ${i.key} "${i.summary}" is open and blocks it.`),
    ];
    const problems = res.problems.filter((p) => p.issueKey === focus.key || p.relatedKeys.includes(focus.key));
    const risk = res.issueRisk.find((r) => r.issueKey === focus.key);
    return {
      ...base,
      focus: { key: focus.key, summary: focus.summary, kind: focus.kind, stage: focus.stage, scheduledFor: focus.scheduledFor, contractor: focus.contractor, risk: risk?.score ?? 0 },
      blockers,
      problems: problems.map((p) => ({ severity: p.severity, why: p.why, proposed: p.proposal.title })),
      pendingProposals: pending.filter((p) => p.targetKey === focus.key || problems.some((pr) => pr.key === p.dedupeKey)).map((p) => ({ id: p.id, title: p.title, kind: p.kind })),
    };
  }

  return {
    ...base,
    problems: res.problems.slice(0, 10).map((p) => ({ issueKey: p.issueKey, severity: p.severity, why: p.why, proposed: p.proposal.title })),
    highestRisk: [...res.issueRisk].sort((a, b) => b.score - a.score).slice(0, 5).filter((r) => r.score > 0).map((r) => ({ issueKey: r.issueKey, score: r.score, why: r.reasons[0] })),
    pendingProposals: pending.slice(0, 10).map((p) => ({ id: p.id, title: p.title, kind: p.kind, targetKey: p.targetKey })),
  };
});

// ---------------- 3. createInspectionReport ----------------

export const createInspectionReport = action('createInspectionReport', async (payload, context) => {
  const projectKey = await projectFor(payload);
  const { issue } = await loadIssue(projectKey, str(payload.inspection, 120), payload);
  if (issue.kind !== 'Inspection') throw new UserFacing(`${issue.key} is a ${issue.kind}, not an Inspection.`);
  const jobId = await enqueueJob('evidence_report', { projectKey, issueKey: issue.key, requestedBy: context.accountId ?? null }, context.accountId ?? null);
  const proposal = await upsertProposal({
    projectKey,
    kind: 'publish_report',
    targetKey: issue.key,
    title: `Publish the verified inspection report for ${issue.key} and request inspector sign-off`,
    payload: { issueKey: issue.key, jobId },
    why: `Requested in Rovo chat. Foreman is drafting a verified report for ${issue.summary} from its field notes, photos and plan sheets.`,
    source: 'agent',
    dedupeKey: `agent:publish_report:${issue.key}:${jobId}`,
    createdBy: context.accountId ?? null,
  });
  return {
    ok: true,
    projectKey,
    issueKey: issue.key,
    jobId,
    proposalId: proposal.id,
    message: `Drafting a verified report for ${issue.key} (about a minute). It will show Verified / Needs review / Conflict lines in the "Field evidence & report" tab. Publishing it is proposal #${proposal.id} in the Approval Queue; the inspection only passes when the inspector signs off.`,
  };
});

// ---------------- 4. proposeResolution ----------------

export const PROPOSAL_KINDS = ['reschedule', 'notify', 'escalate', 'reinspect'] as const;

export function buildResolutionPayload(
  kind: (typeof PROPOSAL_KINDS)[number],
  issue: MonIssue,
  input: { newDate?: string; recipient?: string; message?: string; reason: string },
  today: string,
  jurisdiction: string,
): { title: string; payload: Record<string, unknown> } {
  if (kind === 'reschedule' || kind === 'reinspect') {
    const to = isoDate.parse(input.newDate);
    if (to < today) throw new UserFacing(`The new date ${to} is in the past.`);
    return {
      title: `${kind === 'reschedule' ? 'Reschedule' : 'Re-inspect'} ${issue.key} on ${to}`,
      payload: { issueKey: issue.key, from: issue.scheduledFor ?? null, to, reason: input.reason },
    };
  }
  const to = input.recipient ?? (kind === 'escalate' ? jurisdiction : issue.contractor ?? undefined);
  if (!to) throw new UserFacing('Who should be notified?');
  const message = input.message ?? `${input.reason} (${issue.key} ${issue.summary})`;
  return {
    title: kind === 'escalate' ? `Escalate ${issue.key} to ${to}` : `Notify ${to} about ${issue.key}`,
    payload: { issueKey: issue.key, to, subject: kind === 'escalate' ? `${issue.summary}: request for action` : undefined, message },
  };
}

export const proposeResolution = action('proposeResolution', async (payload, context) => {
  const projectKey = await projectFor(payload);
  const kind = z.enum(PROPOSAL_KINDS).parse(str(payload.kind, 20)?.toLowerCase());
  const reason = str(payload.reason, 500);
  if (!reason) throw new UserFacing('Give a short reason for the proposal.');
  const { issue, snapshot } = await loadIssue(projectKey, str(payload.issue, 120), payload);
  const built = buildResolutionPayload(kind, issue, { newDate: str(payload.newDate, 10), recipient: str(payload.recipient, 120), message: str(payload.message, 2000), reason }, snapshot.today, snapshot.jurisdiction);
  const p = await upsertProposal({
    projectKey,
    kind,
    targetKey: issue.key,
    title: built.title,
    payload: built.payload,
    why: `Proposed in Rovo chat: ${reason}`,
    source: 'agent',
    dedupeKey: `agent:${kind}:${issue.key}:${JSON.stringify(built.payload).length}:${String(built.payload.to ?? '')}`,
    createdBy: context.accountId ?? null,
  });
  return { ok: true, projectKey, proposalId: p.id, created: p.created, title: built.title, message: `Created proposal #${p.id}: ${built.title}. Nothing changes until someone approves it in the Foreman Command Center Approval Queue.` };
});

// ---------------- 5. requestApproval ----------------

export const requestApproval = action('requestApproval', async (payload, context) => {
  const projectKey = await projectFor(payload);
  const { issue, snapshot, all } = await loadIssue(projectKey, str(payload.target, 120), payload);

  if (issue.kind === 'Inspection') {
    const p = await upsertProposal({
      projectKey,
      kind: 'publish_report',
      targetKey: issue.key,
      title: `Publish the latest inspection report for ${issue.key} and request inspector sign-off`,
      payload: { issueKey: issue.key },
      why: str(payload.note, 500) ?? 'Requested in Rovo chat.',
      source: 'agent',
      dedupeKey: `agent:publish_report:${issue.key}:latest`,
      createdBy: context.accountId ?? null,
    });
    return { ok: true, projectKey, proposalId: p.id, message: `Proposal #${p.id} will publish the latest draft report for ${issue.key} once approved. The inspector then signs off in the work item.` };
  }
  if (issue.kind !== 'Permit') throw new UserFacing(`Approval packets are for permits and inspections; ${issue.key} is a ${issue.kind}.`);

  const cfg = await getMonitorConfig(projectKey).catch(() => DEFAULT_CONFIG);
  const res = detect(snapshot, cfg);
  const inspections = all.filter((i) => i.kind === 'Inspection' && i.governedBy === issue.key);
  const keys = new Set([issue.key, ...inspections.map((i) => i.key)]);
  const problems = res.problems.filter((p) => keys.has(p.issueKey) || p.relatedKeys.some((k) => keys.has(k)));
  const sheets = [...new Set([...issue.sheets, ...inspections.flatMap((i) => i.sheets)])];
  const findings = sheets.length
    ? await query<{ rule_id: string; title: string; status: string; sheet_id: string; citation: string }>(
        `SELECT rule_id, title, status, sheet_id, citation FROM findings WHERE project_key = ? AND state IN ('open','approved','ticketed') AND status <> 'pass' AND sheet_id IN (${sheets.map(() => '?').join(',')}) LIMIT 30`,
        projectKey,
        ...sheets,
      )
    : [];
  const prop = await buildSnapshotConditions(issue);
  const packet = buildPermitPacket({
    permit: issue,
    conditions: prop,
    inspections,
    openFindings: findings.map((f) => ({ ruleId: f.rule_id, title: f.title, status: f.status, sheetId: f.sheet_id, citation: f.citation })),
    problems,
    jurisdiction: snapshot.jurisdiction,
    today: snapshot.today,
  });
  const p = await upsertProposal({
    projectKey,
    kind: 'approval_packet',
    targetKey: issue.key,
    title: `Record the approval packet on ${issue.key} for project manager sign-off`,
    payload: { issueKey: issue.key, packetTitle: packet.title, lines: packet.lines, readiness: packet.readiness },
    why: str(payload.note, 500) ?? `Approval packet drafted in Rovo chat (${packet.readiness === 'ready' ? 'ready' : `${packet.blockers.length} blocker(s)`}).`,
    source: 'agent',
    dedupeKey: `agent:approval_packet:${issue.key}:${snapshot.today}`,
    createdBy: context.accountId ?? null,
  });
  return {
    ok: true,
    projectKey,
    proposalId: p.id,
    readiness: packet.readiness,
    blockers: packet.blockers,
    packet: packet.lines.join('\n'),
    message: `Drafted the approval packet for ${issue.key}. Proposal #${p.id} will post it on the permit when approved.`,
  };
});

/** Permit conditions: from the entity property, falling back to the demo dataset for older seeds. */
async function buildSnapshotConditions(permit: MonIssue): Promise<string[]> {
  if (permit.conditions?.length) return permit.conditions;
  return ISSUES.find((i) => i.type === 'Permit' && i.summary === permit.summary)?.conditions ?? [];
}

// ---------------- 6. approvePending ----------------

export const approvePending = action('approvePending', async (payload, context) => {
  const id = z.coerce.number().int().positive().parse(payload.proposalId);
  const confirmed = payload.confirmed === true || payload.confirmed === 'true';
  const p = await getProposal(id);
  if (!p) throw new UserFacing(`Proposal #${id} does not exist.`);
  if (p.state !== 'pending') throw new UserFacing(`Proposal #${id} is already ${p.state}.`);
  if (!confirmed) {
    return { ok: true, projectKey: p.projectKey, needsConfirmation: true, proposal: { id, title: p.title, why: p.why, kind: p.kind }, message: `Proposal #${id}: "${p.title}". Confirm that you want to approve it; it will run as you.` };
  }
  const decided = await decideProposal(id, 'approve', context.accountId ?? null, str(payload.note, 500) ?? 'Approved in Rovo chat', p.projectKey);
  return { ok: true, projectKey: p.projectKey, proposalId: id, state: decided.state, result: decided.result, message: `Approved and executed proposal #${id}: ${p.title}.` };
});
