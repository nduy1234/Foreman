import { addDays, daysBetween, MonIssue } from './monitor/detect';

/**
 * Pure builders for the Command Center visuals: the permit/inspection timeline with a forecast
 * critical path, and the risk heatmap by trade and level.
 */

export interface TimelineRow {
  key: string;
  kind: 'Permit' | 'Inspection';
  summary: string;
  stage: string | null;
  /** Bars (permits): start..end. Milestones (inspections): date. */
  start?: string;
  end?: string;
  date?: string;
  scheduled?: string | null;
  estimated: boolean;
  critical: boolean;
  state: 'done' | 'on_track' | 'at_risk' | 'blocked' | 'unscheduled';
  note: string;
}

export interface Timeline {
  start: string;
  end: string;
  today: string;
  rows: TimelineRow[];
  links: { from: string; to: string; violated: boolean }[];
  criticalPath: string[];
  forecastFinish: string | null;
  slipDays: number;
  why: string;
}

const isDone = (i: MonIssue) => i.stage === 'Passed' || i.stage === 'Approved';
export const human = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const max = (...d: (string | null | undefined)[]) => d.filter((x): x is string => !!x).sort().at(-1) ?? null;
const min = (...d: (string | null | undefined)[]) => d.filter((x): x is string => !!x).sort()[0] ?? null;

/** Order inspections along the "requires prior inspection" chain (prerequisites first). */
export function sequenceOrder(inspections: MonIssue[]): MonIssue[] {
  const byKey = new Map(inspections.map((i) => [i.key, i]));
  const out: MonIssue[] = [];
  const seen = new Set<string>();
  const visit = (i: MonIssue, depth = 0) => {
    if (seen.has(i.key) || depth > 50) return;
    for (const p of i.requiresPrior) {
      const pi = byKey.get(p);
      if (pi) visit(pi, depth + 1);
    }
    seen.add(i.key);
    out.push(i);
  };
  for (const i of [...inspections].sort((a, b) => (a.scheduledFor ?? '9999').localeCompare(b.scheduledFor ?? '9999'))) visit(i);
  return out;
}

export function buildTimeline(issues: MonIssue[], today: string, opts: { bufferDays?: number; gapDays?: number; permitReviewDays?: number } = {}): Timeline {
  const buffer = opts.bufferDays ?? 2;
  const gap = opts.gapDays ?? 7;
  const review = opts.permitReviewDays ?? 21;
  const permits = issues.filter((i) => i.kind === 'Permit');
  const inspections = sequenceOrder(issues.filter((i) => i.kind === 'Inspection'));
  const permitByKey = new Map(permits.map((p) => [p.key, p]));

  // Forecast approval for permits still in review: submitted + typical review, never before today.
  const permitApproval = new Map<string, { date: string; estimated: boolean }>();
  for (const p of permits) {
    if (p.stage === 'Approved') permitApproval.set(p.key, { date: p.submittedOn ? addDays(p.submittedOn, 1) : today, estimated: false });
    else permitApproval.set(p.key, { date: max(p.submittedOn ? addDays(p.submittedOn, review) : null, addDays(today, 3))!, estimated: true });
  }

  const est = new Map<string, string>();
  const rows: TimelineRow[] = [];
  const links: Timeline['links'] = [];
  const critical = new Set<string>();

  for (const i of inspections) {
    const priors = i.requiresPrior.filter((k) => inspections.some((x) => x.key === k));
    for (const p of priors) {
      const pDate = est.get(p);
      const pDone = isDone(inspections.find((x) => x.key === p)!);
      links.push({ from: p, to: i.key, violated: !isDone(i) && !pDone && !!i.scheduledFor && !!pDate && i.scheduledFor < addDays(pDate, buffer) });
    }
    if (isDone(i)) {
      const d = i.inspectedOn ?? i.scheduledFor ?? today;
      est.set(i.key, d);
      rows.push({ key: i.key, kind: 'Inspection', summary: i.summary, stage: i.stage, date: d, scheduled: i.scheduledFor, estimated: false, critical: false, state: 'done', note: `Passed ${d}` });
      continue;
    }
    const permit = i.governedBy ? permitByKey.get(i.governedBy) : undefined;
    const gate = permit && permit.stage !== 'Approved' ? permitApproval.get(permit.key) : undefined;
    const priorDates = priors.map((p) => est.get(p)).filter((d): d is string => !!d);
    const earliestFromPriors = priorDates.length ? addDays(max(...priorDates)!, i.scheduledFor ? buffer : gap) : null;
    const earliestFromPermit = gate ? addDays(gate.date, buffer) : null;
    const forecast = max(i.scheduledFor, earliestFromPriors, earliestFromPermit, today)!;
    est.set(i.key, forecast);
    const reasons: string[] = [];
    if (i.scheduledFor && forecast > i.scheduledFor) reasons.push(`planned ${human(i.scheduledFor)}, forecast ${human(forecast)}`);
    if (earliestFromPriors && i.scheduledFor && earliestFromPriors > i.scheduledFor) reasons.push('prerequisite not passed in time');
    if (gate) reasons.push(`waits for ${permit!.permitNo ?? permit!.key} approval (~${human(gate.date)})`);
    const state: TimelineRow['state'] = gate ? 'blocked' : !i.scheduledFor ? 'unscheduled' : forecast > i.scheduledFor ? 'at_risk' : 'on_track';
    rows.push({
      key: i.key,
      kind: 'Inspection',
      summary: i.summary,
      stage: i.stage,
      date: forecast,
      scheduled: i.scheduledFor,
      estimated: forecast !== i.scheduledFor,
      critical: true,
      state,
      note: reasons.join('; ') || (i.scheduledFor ? `Scheduled ${human(i.scheduledFor)}` : `Not scheduled; earliest ${human(forecast)}`),
    });
    critical.add(i.key);
    if (gate) critical.add(permit!.key);
  }

  for (const p of permits) {
    const appr = permitApproval.get(p.key)!;
    const start = p.submittedOn ?? today;
    const end = p.stage === 'Approved' ? (p.expiresOn ?? addDays(start, 180)) : appr.date;
    const expSoon = p.stage === 'Approved' && p.expiresOn && daysBetween(today, p.expiresOn) <= 21;
    rows.unshift({
      key: p.key,
      kind: 'Permit',
      summary: p.summary,
      stage: p.stage,
      start,
      end,
      estimated: p.stage !== 'Approved',
      critical: critical.has(p.key),
      state: p.stage === 'Approved' ? (expSoon ? 'at_risk' : 'done') : 'blocked',
      note: p.stage === 'Approved' ? `Approved; expires ${p.expiresOn ? human(p.expiresOn) : 'n/a'}` : `${p.stage} since ${p.submittedOn ? human(p.submittedOn) : '?'}; forecast approval ~${human(appr.date)}`,
    });
  }

  const finalInsp = inspections.at(-1);
  const forecastFinish = finalInsp ? (est.get(finalInsp.key) ?? null) : null;
  const plannedFinish = finalInsp?.scheduledFor ?? null;
  const firstOpen = inspections.find((i) => !isDone(i));
  const slipDays = forecastFinish && firstOpen?.scheduledFor ? Math.max(0, ...rows.filter((r) => r.kind === 'Inspection' && r.scheduled && r.date).map((r) => daysBetween(r.scheduled!, r.date!))) : 0;
  // Window: from the earliest submission/inspection to two weeks past the forecast finish.
  // Long permit validity bars are clipped at the edge rather than stretching the axis.
  const startDates = rows.flatMap((r) => [r.start, r.date, r.scheduled]).filter((d): d is string => !!d);
  const endDates = rows.filter((r) => r.kind === 'Inspection').flatMap((r) => [r.date, r.scheduled]).filter((d): d is string => !!d);
  const drivers = rows
    .filter((r) => r.critical && (r.state === 'blocked' || r.state === 'at_risk'))
    .map((r) => `${r.key} ${r.summary.split(' - ')[0]} (${r.note})`);
  return {
    start: addDays(min(...startDates, today)!, -3),
    end: addDays(max(...endDates, forecastFinish, addDays(today, 30))!, 14),
    today,
    rows,
    links,
    criticalPath: inspections.filter((i) => critical.has(i.key)).map((i) => i.key),
    forecastFinish,
    slipDays,
    why: forecastFinish
      ? `Final inspection forecast ${human(forecastFinish)}${plannedFinish ? ` (planned ${human(plannedFinish)})` : ''}. ${drivers.length ? `Driving the critical path: ${drivers.slice(0, 3).join('; ')}.` : 'No slips on the critical path.'}`
      : 'No inspections yet.',
  };
}

// ---------------- heatmap ----------------

export interface HeatCell {
  trade: string;
  level: string;
  score: number;
  count: number;
  keys: string[];
}
export interface Heatmap {
  trades: string[];
  levels: string[];
  cells: HeatCell[];
  max: number;
}

const LEVEL_ORDER = (l: string) => {
  if (/foundation/i.test(l)) return 0;
  const m = l.match(/level\s*(\d+)/i);
  if (m && !/levels/i.test(l)) return Number(m[1]);
  if (/levels?\s*\d+\s*-\s*\d+/i.test(l)) return 50;
  return 99;
};

export function buildHeatmap(issues: { key: string; trade?: string | null; level?: string | null }[], riskByKey: Record<string, number>): Heatmap {
  const cells = new Map<string, HeatCell>();
  for (const i of issues) {
    const trade = i.trade || 'Unassigned';
    const level = i.level || 'Unassigned';
    const k = `${trade}|${level}`;
    const c = cells.get(k) ?? { trade, level, score: 0, count: 0, keys: [] };
    c.count++;
    c.keys.push(i.key);
    c.score = Math.max(c.score, riskByKey[i.key] ?? 0);
    cells.set(k, c);
  }
  const all = [...cells.values()];
  const tradeTotals = new Map<string, number>();
  for (const c of all) tradeTotals.set(c.trade, (tradeTotals.get(c.trade) ?? 0) + c.score);
  const trades = [...tradeTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const levels = [...new Set(all.map((c) => c.level))].sort((a, b) => LEVEL_ORDER(a) - LEVEL_ORDER(b) || a.localeCompare(b));
  return { trades, levels, cells: all, max: Math.max(0, ...all.map((c) => c.score)) };
}
