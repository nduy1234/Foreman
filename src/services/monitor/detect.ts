import { ProposalKind, Severity } from '../../lib/schemas';
import { Detector, isEnabled, MonitorConfig } from './config';

/**
 * Project monitor (pure). Takes a snapshot of the project's work items and returns problems,
 * per-issue and per-project risk scores with plain-English reasons, and one proposed resolution
 * per problem. Nothing here writes anything; proposals are approved by a human elsewhere.
 */

export interface MonIssue {
  key: string;
  id: string;
  kind: 'Permit' | 'Inspection' | 'RFI' | 'Punch Item' | 'Code Finding' | string;
  summary: string;
  stage: string | null;
  statusCategory: 'new' | 'indeterminate' | 'done' | string;
  permitNo?: string | null;
  scheduledFor?: string | null;
  submittedOn?: string | null;
  expiresOn?: string | null;
  openedOn?: string | null;
  inspectedOn?: string | null;
  contractor?: string | null;
  inspector?: string | null;
  assignment?: { contractor?: string | null; assignedAt?: string | null; acknowledgedAt?: string | null } | null;
  /** Keys this issue requires to pass first (outward "requires prior inspection"). */
  requiresPrior: string[];
  /** Permit this issue is governed by. */
  governedBy: string | null;
  /** Keys this issue blocks (outward "blocks"). */
  blocks: string[];
  sheets: string[];
  latestReport?: { state: string; conflicts: number; version: number } | null;
}

export interface Snapshot {
  projectKey: string;
  jurisdiction: string;
  today: string; // YYYY-MM-DD
  now: string; // ISO
  issues: MonIssue[];
  /** Open failing plan-review findings by sheet id. */
  openFailFindingsBySheet: Record<string, number>;
  /** Field note / transcript text per issue key. */
  notesByIssue: Record<string, string[]>;
  /** Plan sheet text by sheet id. */
  planTextBySheet: Record<string, string>;
}

/** Reinforcing bar callouts like "#5 bars @ 12 in." -> "#5@12". */
export function rebarCallouts(text: string): { spec: string; quote: string }[] {
  const out: { spec: string; quote: string }[] = [];
  const re = /#\s?(\d{1,2})\s*(?:bars?)?\s*@\s*(\d{1,2})\s*(?:in\.?|\")\s*o\.?c\.?/gi;
  for (const m of text.matchAll(re)) out.push({ spec: `#${m[1]}@${m[2]}`, quote: m[0].trim() });
  return out;
}

export interface ProposedAction {
  kind: ProposalKind;
  title: string;
  payload: Record<string, unknown>;
}

export interface Problem {
  key: string; // stable dedupe key: detector:issue[:detail]
  detector: Detector;
  issueKey: string;
  relatedKeys: string[];
  severity: Severity;
  points: number;
  title: string;
  why: string;
  proposal: ProposedAction;
}

export interface IssueRisk {
  issueKey: string;
  score: number;
  band: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface MonitorResult {
  projectKey: string;
  computedAt: string;
  problems: Problem[];
  issueRisk: IssueRisk[];
  project: { score: number; band: 'low' | 'medium' | 'high'; why: string; counts: Record<Severity, number> };
}

const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY);
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10)) + n * DAY).toISOString().slice(0, 10);
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const SEVERITY_POINTS: Record<Severity, number> = { critical: 45, high: 30, medium: 18, low: 8 };
const passed = (i?: MonIssue) => i?.stage === 'Passed';

export function detect(s: Snapshot, cfg: MonitorConfig): MonitorResult {
  const byKey = new Map(s.issues.map((i) => [i.key, i]));
  const problems: Problem[] = [];
  const add = (p: Omit<Problem, 'points'> & { points?: number }) => problems.push({ ...p, points: p.points ?? SEVERITY_POINTS[p.severity] });
  const inspections = s.issues.filter((i) => i.kind === 'Inspection');
  const openInspection = (i: MonIssue) => !passed(i) && i.stage !== 'Failed';
  /** Earliest scheduled, not-yet-passed inspection this issue blocks (to raise urgency). */
  const blockedUpcoming = (i: MonIssue) =>
    i.blocks
      .map((k) => byKey.get(k))
      .filter((b): b is MonIssue => !!b && b.kind === 'Inspection' && openInspection(b) && !!b.scheduledFor)
      .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!))[0];

  // 1. Inspection scheduled before its prerequisite passes.
  if (isEnabled(cfg, 'sequence_violation')) {
    for (const insp of inspections) {
      if (insp.stage !== 'Scheduled' || !insp.scheduledFor) continue;
      for (const pk of insp.requiresPrior) {
        const prior = byKey.get(pk);
        if (!prior || passed(prior)) continue;
        const priorDate = prior.scheduledFor ?? null;
        if (priorDate && priorDate < insp.scheduledFor) continue; // prerequisite comes first; fine for now
        const newDate = addDays(priorDate && priorDate > s.today ? priorDate : s.today, cfg.rescheduleBufferDays + (priorDate ? 0 : 7));
        add({
          key: `sequence_violation:${insp.key}:${prior.key}`,
          detector: 'sequence_violation',
          issueKey: insp.key,
          relatedKeys: [prior.key],
          severity: daysBetween(s.today, insp.scheduledFor) <= 7 ? 'high' : 'medium',
          title: `${insp.summary} is scheduled before ${prior.summary} passes`,
          why: `${insp.key} is scheduled for ${fmtDate(insp.scheduledFor)}, but its prerequisite ${prior.key} is ${prior.stage ?? 'not passed'}${priorDate ? ` (scheduled ${fmtDate(priorDate)})` : ''}. The city will not pass it out of sequence.`,
          proposal: {
            kind: 'reschedule',
            title: `Reschedule ${insp.key} to ${fmtDate(newDate)}`,
            payload: { issueKey: insp.key, from: insp.scheduledFor, to: newDate, reason: `Wait for ${prior.key} to pass` },
          },
        });
      }
    }
  }

  // 2. Inspection under a permit that is not approved (or is expired).
  if (isEnabled(cfg, 'permit_not_approved')) {
    for (const insp of inspections) {
      if (!openInspection(insp) || !insp.governedBy) continue;
      const permit = byKey.get(insp.governedBy);
      if (!permit || permit.stage === 'Approved') continue;
      add({
        key: `permit_not_approved:${insp.key}:${permit.key}`,
        detector: 'permit_not_approved',
        issueKey: insp.key,
        relatedKeys: [permit.key],
        severity: insp.scheduledFor && daysBetween(s.today, insp.scheduledFor) <= 14 ? 'high' : 'medium',
        title: `${insp.summary} depends on ${permit.permitNo ?? permit.key}, which is ${permit.stage}`,
        why: `${insp.key}${insp.scheduledFor ? ` (scheduled ${fmtDate(insp.scheduledFor)})` : ''} is governed by permit ${permit.permitNo ?? permit.key}, which is still ${permit.stage}. Work cannot be inspected for approval until the permit is issued.`,
        proposal: {
          kind: 'escalate',
          title: `Ask ${s.jurisdiction} to expedite ${permit.permitNo ?? permit.key}`,
          payload: {
            issueKey: permit.key,
            to: s.jurisdiction,
            subject: `Request to expedite review of ${permit.permitNo ?? permit.key}`,
            message: `${insp.summary} is planned${insp.scheduledFor ? ` for ${fmtDate(insp.scheduledFor)}` : ''} and depends on permit ${permit.permitNo ?? permit.key}. Please advise on the review status and any open comments.`,
          },
        },
      });
    }
  }

  // 3. Permit stuck in review.
  if (isEnabled(cfg, 'stuck_review')) {
    for (const p of s.issues.filter((i) => i.kind === 'Permit' && (i.stage === 'In Review' || i.stage === 'Submitted') && i.submittedOn)) {
      const age = daysBetween(p.submittedOn!, s.today);
      if (age < cfg.stuckReviewDays) continue;
      const dependents = inspections.filter((i) => i.governedBy === p.key && openInspection(i));
      add({
        key: `stuck_review:${p.key}`,
        detector: 'stuck_review',
        issueKey: p.key,
        relatedKeys: dependents.map((d) => d.key),
        severity: age >= cfg.stuckReviewDays * 2 || dependents.length ? 'high' : 'medium',
        title: `${p.permitNo ?? p.key} has been ${p.stage?.toLowerCase()} for ${age} days`,
        why: `${p.summary} was submitted ${age} days ago (threshold ${cfg.stuckReviewDays}) and is still ${p.stage}.${dependents.length ? ` ${dependents.length} inspection(s) depend on it: ${dependents.map((d) => d.key).join(', ')}.` : ''}`,
        proposal: {
          kind: 'escalate',
          title: `Escalate ${p.permitNo ?? p.key} review to ${s.jurisdiction}`,
          payload: {
            issueKey: p.key,
            to: s.jurisdiction,
            subject: `Status request: ${p.permitNo ?? p.key} in review ${age} days`,
            message: `Permit ${p.permitNo ?? p.key} was submitted on ${fmtDate(p.submittedOn!)} and has been in review for ${age} days. Please share plan-check comments or an expected decision date.`,
          },
        },
      });
    }
  }

  // 4. Permit nearing expiry (or expired) while work under it is still open.
  if (isEnabled(cfg, 'permit_expiring')) {
    for (const p of s.issues.filter((i) => i.kind === 'Permit' && i.stage === 'Approved' && i.expiresOn)) {
      const left = daysBetween(s.today, p.expiresOn!);
      if (left > cfg.expiryWarnDays) continue;
      const openUnder = inspections.filter((i) => i.governedBy === p.key && openInspection(i));
      add({
        key: `permit_expiring:${p.key}`,
        detector: 'permit_expiring',
        issueKey: p.key,
        relatedKeys: openUnder.map((i) => i.key),
        severity: left < 0 ? 'critical' : left <= 7 ? 'high' : 'medium',
        title: left < 0 ? `${p.permitNo ?? p.key} expired ${-left} days ago` : `${p.permitNo ?? p.key} expires in ${left} days`,
        why: `${p.summary} ${left < 0 ? 'expired' : 'expires'} on ${fmtDate(p.expiresOn!)}${openUnder.length ? ` with ${openUnder.length} inspection(s) still open under it` : ''}. Most jurisdictions require an extension request before expiry.`,
        proposal: {
          kind: 'escalate',
          title: `Request extension of ${p.permitNo ?? p.key}`,
          payload: {
            issueKey: p.key,
            to: s.jurisdiction,
            subject: `Permit extension request: ${p.permitNo ?? p.key}`,
            message: `We request a 180-day extension of permit ${p.permitNo ?? p.key} (expires ${fmtDate(p.expiresOn!)}). Work is active and inspections are scheduled.`,
          },
        },
      });
    }
  }

  // 5. Contractor has not acknowledged an assignment.
  if (isEnabled(cfg, 'unacknowledged_assignment')) {
    for (const i of s.issues) {
      const a = i.assignment;
      if (!a?.assignedAt || a.acknowledgedAt || passed(i)) continue;
      const hours = Math.floor((Date.parse(s.now) - Date.parse(a.assignedAt)) / 3_600_000);
      if (hours < cfg.ackHours) continue;
      const who = a.contractor ?? i.contractor ?? 'the contractor';
      add({
        key: `unacknowledged_assignment:${i.key}`,
        detector: 'unacknowledged_assignment',
        issueKey: i.key,
        relatedKeys: [],
        severity: i.scheduledFor && daysBetween(s.today, i.scheduledFor) <= 14 ? 'high' : 'medium',
        title: `${who} has not confirmed ${i.summary}`,
        why: `${who} was assigned ${i.key} ${hours} hours ago (threshold ${cfg.ackHours} h) and has not acknowledged it${i.scheduledFor ? `; the inspection is on ${fmtDate(i.scheduledFor)}` : ''}.`,
        proposal: {
          kind: 'notify',
          title: `Ask ${who} to confirm ${i.key}`,
          payload: {
            issueKey: i.key,
            to: who,
            message: `Please confirm you will be ready for ${i.summary}${i.scheduledFor ? ` on ${fmtDate(i.scheduledFor)}` : ''}. Reply in Jira or call the superintendent.`,
          },
        },
      });
    }
  }

  // 6. Inspection date passed but nothing was recorded (no-show).
  if (isEnabled(cfg, 'inspection_no_show')) {
    for (const i of inspections) {
      if (i.stage !== 'Scheduled' || !i.scheduledFor) continue;
      const late = daysBetween(i.scheduledFor, s.today);
      if (late <= cfg.noShowGraceDays) continue;
      if (i.latestReport) continue;
      add({
        key: `inspection_no_show:${i.key}:${i.scheduledFor}`,
        detector: 'inspection_no_show',
        issueKey: i.key,
        relatedKeys: [],
        severity: 'high',
        title: `${i.summary} was due ${late} days ago with no result`,
        why: `${i.key} was scheduled for ${fmtDate(i.scheduledFor)}, ${late} days ago, but has no inspection report or result. ${i.contractor ?? 'The contractor'} or the inspector may not have shown up.`,
        proposal: {
          kind: 'reinspect',
          title: `Book a new inspection date for ${i.key}`,
          payload: { issueKey: i.key, from: i.scheduledFor, to: addDays(s.today, 3), reason: 'No result recorded on the scheduled date' },
        },
      });
    }
  }

  // 7. Report / plan / Jira-status contradictions.
  if (isEnabled(cfg, 'status_contradiction')) {
    for (const i of inspections) {
      const rep = i.latestReport;
      const reasons: string[] = [];
      if (i.statusCategory === 'done' && i.stage !== 'Passed') reasons.push(`Jira shows it as done but the Foreman stage is ${i.stage ?? 'unknown'} (no inspector sign-off)`);
      // Field notes call out reinforcement that is not on the referenced plan sheets.
      const planSpecs = new Map<string, string>();
      for (const sh of i.sheets) for (const c of rebarCallouts(s.planTextBySheet[sh] ?? '')) planSpecs.set(c.spec, `${sh}: "${c.quote}"`);
      if (planSpecs.size) {
        for (const note of s.notesByIssue[i.key] ?? []) {
          const odd = rebarCallouts(note).find((c) => !planSpecs.has(c.spec));
          if (odd) {
            reasons.push(`field notes record "${odd.quote}" but the plan calls for ${[...planSpecs.values()].join(' / ')}`);
            break;
          }
        }
      }
      if (passed(i) && rep && rep.state !== 'approved') reasons.push(`it is marked Passed but report v${rep.version} is ${rep.state.replace('_', ' ')}`);
      if (rep && rep.conflicts > 0 && (passed(i) || i.statusCategory === 'done')) reasons.push(`report v${rep.version} lists ${rep.conflicts} conflict(s) between field evidence and the plan`);
      const failing = passed(i) ? i.sheets.reduce((n, sh) => n + (s.openFailFindingsBySheet[sh] ?? 0), 0) : 0;
      if (failing) reasons.push(`${failing} open code finding(s) fail on its plan sheet(s) ${i.sheets.join(', ')}`);
      if (!reasons.length) continue;
      if (passed(i) && !rep) reasons.push('no signed Foreman inspection report backs the Passed status');
      const hard = (rep?.conflicts ?? 0) > 0 || (i.statusCategory === 'done' && i.stage !== 'Passed') || reasons.some((r) => r.startsWith('field notes record'));
      add({
        key: `status_contradiction:${i.key}`,
        detector: 'status_contradiction',
        issueKey: i.key,
        relatedKeys: [],
        severity: hard ? 'high' : 'medium',
        title: `${i.summary}: status does not match the evidence`,
        why: `${i.key}: ${reasons.join('; ')}.`,
        proposal: {
          kind: 'reinspect',
          title: `Re-inspect ${i.key} and generate a verified report`,
          payload: { issueKey: i.key, to: addDays(s.today, 3), reason: reasons[0] },
        },
      });
    }
  }

  // 8. RFIs open too long (worse when they block an upcoming inspection).
  if (isEnabled(cfg, 'rfi_aging')) {
    for (const r of s.issues.filter((i) => i.kind === 'RFI' && i.stage === 'Open' && i.openedOn)) {
      const age = daysBetween(r.openedOn!, s.today);
      if (age < cfg.rfiAgeDays) continue;
      const blocked = blockedUpcoming(r) ?? r.blocks.map((k) => byKey.get(k)).find((b) => b && !passed(b) && b.stage !== 'Approved');
      add({
        key: `rfi_aging:${r.key}`,
        detector: 'rfi_aging',
        issueKey: r.key,
        relatedKeys: blocked ? [blocked.key] : [],
        severity: blocked ? 'high' : age >= cfg.rfiAgeDays * 2 ? 'medium' : 'low',
        title: `${r.summary.split(' ')[0]} open ${age} days${blocked ? `, blocking ${blocked.key}` : ''}`,
        why: `${r.summary} has been open ${age} days (threshold ${cfg.rfiAgeDays})${blocked ? ` and blocks ${blocked.summary}` : ''}.`,
        proposal: {
          kind: 'notify',
          title: `Chase the design team on ${r.key}`,
          payload: { issueKey: r.key, to: 'Architect of record', message: `${r.summary} has been open ${age} days${blocked ? ` and is blocking ${blocked.summary}` : ''}. Please respond or give a date.` },
        },
      });
    }
  }

  // ---- risk ----
  const perIssue = new Map<string, { points: number; reasons: { p: number; why: string }[] }>();
  const bump = (key: string, points: number, why: string) => {
    const e = perIssue.get(key) ?? { points: 0, reasons: [] };
    e.points += points;
    e.reasons.push({ p: points, why });
    perIssue.set(key, e);
  };
  for (const p of problems) {
    bump(p.issueKey, p.points, p.why);
    for (const rk of p.relatedKeys) bump(rk, Math.round(p.points / 3), `Affected by: ${p.title}`);
  }
  const band = (n: number): IssueRisk['band'] => (n >= 60 ? 'high' : n >= 30 ? 'medium' : 'low');
  const issueRisk: IssueRisk[] = s.issues.map((i) => {
    const e = perIssue.get(i.key);
    const score = Math.min(100, e?.points ?? 0);
    return { issueKey: i.key, score, band: band(score), reasons: (e?.reasons ?? []).sort((a, b) => b.p - a.p).map((r) => r.why) };
  });

  const sorted = [...issueRisk].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 5).map((r) => r.score);
  const projectScore = top.length ? Math.min(100, Math.round(0.6 * top[0] + (0.4 * top.reduce((x, y) => x + y, 0)) / top.length)) : 0;
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const p of problems) counts[p.severity]++;
  const sev = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const topProblems = [...problems].sort((a, b) => sev[a.severity] - sev[b.severity] || b.points - a.points).slice(0, 3);
  const why = problems.length
    ? `${problems.length} open problem(s): ${counts.critical + counts.high} critical/high. Biggest drivers: ${topProblems.map((p) => p.title).join('; ')}.`
    : 'No open problems detected.';

  return {
    projectKey: s.projectKey,
    computedAt: s.now,
    problems: problems.sort((a, b) => sev[a.severity] - sev[b.severity] || b.points - a.points),
    issueRisk,
    project: { score: projectScore, band: band(projectScore), why, counts },
  };
}
