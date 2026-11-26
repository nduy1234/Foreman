import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/kvs', () => ({ kvs: {}, WhereConditions: {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import { buildIssues, FIELD_NOTES, LINKS, PLAN_SHEETS, PROJECT_META, stageCategory } from '../src/seed/dataset';
import { DEFAULT_CONFIG, MonitorConfig } from '../src/services/monitor/config';
import { detect, MonIssue, rebarCallouts, Snapshot } from '../src/services/monitor/detect';
import { digestText } from '../src/services/monitor/digest';
import { desiredLabels } from '../src/services/monitor/run';
import { shouldQueueScan } from '../src/triggers';

const SEED = new Date('2026-11-25T15:00:00Z');

/** Snapshot of the seeded demo project as the monitor would see it on seed day (keys = seed ids). */
function demoSnapshot(overrides: Partial<Record<string, Partial<MonIssue>>> = {}, at = SEED): Snapshot {
  const built = buildIssues(SEED);
  const issues: MonIssue[] = built.map((b) => ({
    key: b.seedId,
    id: b.seedId,
    kind: b.type,
    summary: b.summary,
    stage: b.stage,
    statusCategory: stageCategory(b.stage),
    permitNo: b.permitNo ?? null,
    scheduledFor: b.dates.scheduledFor ?? null,
    submittedOn: b.dates.submittedOn ?? null,
    expiresOn: b.dates.expiresOn ?? null,
    openedOn: b.dates.openedOn ?? null,
    inspectedOn: b.dates.inspectedOn ?? null,
    contractor: b.contractor ?? null,
    assignment: b.assignment ? { contractor: 'Volt MEP', assignedAt: b.assignmentAt, acknowledgedAt: b.assignment.acknowledged ? b.assignmentAt : null } : null,
    requiresPrior: LINKS.filter((l) => l.kind === 'requiresPrior' && l.from === b.seedId).map((l) => l.to),
    governedBy: LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId)?.to ?? null,
    blocks: LINKS.filter((l) => l.kind === 'blocks' && l.from === b.seedId).map((l) => l.to),
    sheets: b.sheets ?? [],
    latestReport: null,
    ...overrides[b.seedId],
  }));
  const notesByIssue: Record<string, string[]> = {};
  for (const n of FIELD_NOTES) (notesByIssue[n.issue] ??= []).push(n.text);
  return {
    projectKey: 'FMD',
    jurisdiction: PROJECT_META.jurisdiction,
    today: at.toISOString().slice(0, 10),
    now: at.toISOString(),
    issues,
    openFailFindingsBySheet: {},
    notesByIssue,
    planTextBySheet: Object.fromEntries(PLAN_SHEETS.map((s) => [s.sheetId, s.text])),
  };
}

const find = (r: ReturnType<typeof detect>, detector: string, issue: string) => r.problems.find((p) => p.detector === detector && p.issueKey === issue);

describe('monitor finds every planted problem in the demo project', () => {
  const r = detect(demoSnapshot(), DEFAULT_CONFIG);

  it('A: framing scheduled before the slab inspection passes -> propose reschedule after slab', () => {
    const p = find(r, 'sequence_violation', 'I5')!;
    expect(p).toBeDefined();
    expect(p.relatedKeys).toEqual(['I4']);
    expect(p.severity).toBe('high');
    expect(p.why).toMatch(/prerequisite I4 is Scheduled/);
    expect(p.proposal.kind).toBe('reschedule');
    expect(p.proposal.payload).toMatchObject({ issueKey: 'I5', from: '2026-11-28', to: '2026-12-02' });
    // MEP rough-in comes after framing in time, so it is not flagged for sequence.
    expect(find(r, 'sequence_violation', 'I6')).toBeUndefined();
  });

  it('B: MEP permit stuck in review 12 days -> escalate to the city', () => {
    const p = find(r, 'stuck_review', 'P3')!;
    expect(p.why).toMatch(/submitted 12 days ago \(threshold 10\)/);
    expect(p.severity).toBe('high'); // an inspection depends on it
    expect(p.proposal).toMatchObject({ kind: 'escalate', payload: { to: 'City of Riverside (demo)' } });
  });

  it('C: rebar field note contradicts S-101 on a Passed inspection -> re-inspect', () => {
    const p = find(r, 'status_contradiction', 'I2')!;
    expect(p.severity).toBe('high');
    expect(p.why).toContain('#4 bars @ 18 in. o.c.');
    expect(p.why).toContain('S-101');
    expect(p.proposal.kind).toBe('reinspect');
    expect(find(r, 'status_contradiction', 'I1')).toBeUndefined(); // passed, no contradicting evidence
  });

  it('D: RFI-4 aging 9 days and blocking the fire sprinkler permit -> notify', () => {
    const p = find(r, 'rfi_aging', 'R4')!;
    expect(p.why).toMatch(/open 9 days/);
    expect(p.relatedKeys).toEqual(['P4']);
    expect(p.proposal.kind).toBe('notify');
    expect(find(r, 'rfi_aging', 'R2')).toBeUndefined(); // 4 days, under threshold
  });

  it('E: Volt MEP has not acknowledged the rough-in assignment for 60 h -> notify contractor', () => {
    const p = find(r, 'unacknowledged_assignment', 'I6')!;
    expect(p.why).toMatch(/Volt MEP was assigned I6 60 hours ago/);
    expect(p.proposal).toMatchObject({ kind: 'notify', payload: { to: 'Volt MEP' } });
  });

  it('F: foundation permit expires in 14 days -> request extension', () => {
    const p = find(r, 'permit_expiring', 'P1')!;
    expect(p.title).toMatch(/expires in 14 days/);
    expect(p.severity).toBe('medium');
    expect(p.proposal.kind).toBe('escalate');
  });

  it('G: MEP rough-in depends on a permit that is still in review', () => {
    expect(find(r, 'permit_not_approved', 'I6')!.relatedKeys).toEqual(['P3']);
  });

  it('every problem has a plain-English why and an approvable proposal (never an auto-action)', () => {
    for (const p of r.problems) {
      expect(p.why.length).toBeGreaterThan(30);
      expect(['reschedule', 'notify', 'escalate', 'reinspect']).toContain(p.proposal.kind);
      expect(p.proposal.title.length).toBeGreaterThan(5);
    }
    expect(new Set(r.problems.map((p) => p.key)).size).toBe(r.problems.length);
  });

  it('scores issues and the project with reasons', () => {
    const i5 = r.issueRisk.find((x) => x.issueKey === 'I5')!;
    expect(i5.score).toBeGreaterThanOrEqual(30);
    expect(i5.reasons[0]).toMatch(/scheduled for/);
    const i4 = r.issueRisk.find((x) => x.issueKey === 'I4')!;
    expect(i4.score).toBeGreaterThan(0); // related to the sequence problem
    expect(r.issueRisk.find((x) => x.issueKey === 'PI1')!.score).toBe(0);
    expect(r.project.score).toBeGreaterThan(40);
    expect(r.project.band).not.toBe('low');
    expect(r.project.why).toMatch(/open problem\(s\)/);
  });
});

describe('monitor rules are configurable', () => {
  it('thresholds change what is detected', () => {
    const cfg = MonitorConfig.parse({ stuckReviewDays: 20, rfiAgeDays: 10, expiryWarnDays: 7, ackHours: 72 });
    const r = detect(demoSnapshot(), cfg);
    expect(r.problems.some((p) => p.detector === 'stuck_review')).toBe(false);
    expect(r.problems.some((p) => p.detector === 'rfi_aging')).toBe(false);
    expect(r.problems.some((p) => p.detector === 'permit_expiring')).toBe(false);
    expect(r.problems.some((p) => p.detector === 'unacknowledged_assignment')).toBe(false);
  });

  it('checks can be switched off', () => {
    const cfg = MonitorConfig.parse({ enabled: { sequence_violation: false, status_contradiction: false } });
    const r = detect(demoSnapshot(), cfg);
    expect(r.problems.some((p) => p.detector === 'sequence_violation' || p.detector === 'status_contradiction')).toBe(false);
    expect(r.problems.some((p) => p.detector === 'stuck_review')).toBe(true);
  });

  it('rejects invalid config', () => {
    expect(() => MonitorConfig.parse({ stuckReviewDays: 0 })).toThrow();
  });
});

describe('time-based detectors', () => {
  it('flags a no-show once the scheduled date passes with no result', () => {
    const later = new Date('2026-12-01T15:00:00Z'); // framing was due Nov 28
    const r = detect(demoSnapshot({}, later), DEFAULT_CONFIG);
    const p = find(r, 'inspection_no_show', 'I5')!;
    expect(p.why).toMatch(/3 days ago/);
    expect(p.proposal.kind).toBe('reinspect');
  });

  it('an expired permit is critical', () => {
    const r = detect(demoSnapshot({}, new Date('2026-12-12T15:00:00Z')), DEFAULT_CONFIG);
    expect(find(r, 'permit_expiring', 'P1')!.severity).toBe('critical');
  });

  it('problems clear when the data is fixed', () => {
    const fixed = detect(
      demoSnapshot({ I4: { stage: 'Passed' }, P3: { stage: 'Approved' }, I6: { assignment: { contractor: 'Volt MEP', assignedAt: '2026-11-22T00:00:00Z', acknowledgedAt: '2026-11-22T05:00:00Z' } } }),
      DEFAULT_CONFIG,
    );
    expect(find(fixed, 'sequence_violation', 'I5')).toBeUndefined();
    expect(find(fixed, 'stuck_review', 'P3')).toBeUndefined();
    expect(find(fixed, 'permit_not_approved', 'I6')).toBeUndefined();
    expect(find(fixed, 'unacknowledged_assignment', 'I6')).toBeUndefined();
  });
});

describe('status contradictions', () => {
  it('Jira moved to done without inspector sign-off', () => {
    const r = detect(demoSnapshot({ I4: { statusCategory: 'done', stage: 'Scheduled' } }), DEFAULT_CONFIG);
    expect(find(r, 'status_contradiction', 'I4')!.why).toMatch(/no inspector sign-off/);
  });
  it('a Passed inspection whose latest report has conflicts', () => {
    const r = detect(demoSnapshot({ I3: { latestReport: { state: 'approved', conflicts: 2, version: 1 } } }), DEFAULT_CONFIG);
    expect(find(r, 'status_contradiction', 'I3')!.why).toMatch(/2 conflict/);
  });
  it('parses rebar callouts', () => {
    expect(rebarCallouts('#5 bars @ 12 in. o.c. each way; DOWELS: #5 @ 16 in. o.c.').map((c) => c.spec)).toEqual(['#5@12', '#5@16']);
  });
});

describe('labels, digest and debounce', () => {
  it('computes label diffs without touching other labels', () => {
    expect(desiredLabels('high', ['sequence_violation'], ['foreman-demo', 'foreman-risk-low', 'foreman-flag-rfi-aging'])).toEqual({
      add: ['foreman-risk-high', 'foreman-flag-sequence-violation'],
      remove: ['foreman-risk-low', 'foreman-flag-rfi-aging'],
    });
    expect(desiredLabels('low', [], ['foreman-risk-low'])).toEqual({ add: [], remove: [] });
  });

  it('renders a readable digest', () => {
    const text = digestText({
      projectKey: 'FMD',
      date: '2026-11-26',
      risk: { score: 72, band: 'high', why: '7 open problems.' },
      newProblems: [{ issueKey: 'FMD-9', severity: 'high', title: 'Framing before slab' }],
      openProblems: [{ issueKey: 'FMD-9', severity: 'high', title: 'Framing before slab', ageDays: 0 }],
      resolved: [],
      pendingProposals: [{ id: 3, title: 'Reschedule FMD-9 to Dec 2', targetKey: 'FMD-9' }],
      decisions: [],
    });
    expect(text).toContain('Project risk 72/100 (high)');
    expect(text).toContain('[high] FMD-9: Framing before slab');
    expect(text).toContain('#3 Reschedule FMD-9 to Dec 2');
  });

  it('debounces bursts of issue events', () => {
    expect(shouldQueueScan(undefined, 1000)).toBe(true);
    expect(shouldQueueScan(1000, 1000 + 30_000)).toBe(false);
    expect(shouldQueueScan(1000, 1000 + 120_000)).toBe(true);
  });
});
