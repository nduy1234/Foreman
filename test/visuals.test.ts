import { describe, expect, it } from 'vitest';
import { buildIssues, LINKS, stageCategory } from '../src/seed/dataset';
import { MonIssue } from '../src/services/monitor/detect';
import { buildHeatmap, buildTimeline, sequenceOrder } from '../src/services/visuals';

const SEED = new Date('2026-11-25T15:00:00Z');
const TODAY = '2026-11-25';
const issues: MonIssue[] = buildIssues(SEED).map((b) => ({
  key: b.seedId,
  id: b.seedId,
  kind: b.type,
  summary: b.summary,
  stage: b.stage,
  statusCategory: stageCategory(b.stage),
  permitNo: b.permitNo ?? null,
  trade: b.trade,
  level: b.level,
  scheduledFor: b.dates.scheduledFor ?? null,
  submittedOn: b.dates.submittedOn ?? null,
  expiresOn: b.dates.expiresOn ?? null,
  inspectedOn: b.dates.inspectedOn ?? null,
  requiresPrior: LINKS.filter((l) => l.kind === 'requiresPrior' && l.from === b.seedId).map((l) => l.to),
  governedBy: LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId)?.to ?? null,
  blocks: [],
  sheets: [],
}));

describe('timeline with critical path', () => {
  const t = buildTimeline(issues, TODAY);
  const row = (k: string) => t.rows.find((r) => r.key === k)!;

  it('orders inspections along the required sequence', () => {
    expect(sequenceOrder(issues.filter((i) => i.kind === 'Inspection')).map((i) => i.key)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8']);
  });

  it('marks the violated link where framing is scheduled before slab', () => {
    expect(t.links.find((l) => l.from === 'I4' && l.to === 'I5')!.violated).toBe(true);
    expect(t.links.find((l) => l.from === 'I1' && l.to === 'I2')!.violated).toBe(false);
  });

  it('forecasts framing after slab and MEP rough-in after the MEP permit', () => {
    expect(row('I4').date).toBe('2026-11-30');
    expect(row('I5').date).toBe('2026-12-02'); // slab + 2-day buffer, not the planned Nov 28
    expect(row('I5').state).toBe('at_risk');
    expect(row('I6').state).toBe('blocked');
    expect(row('I6').note).toMatch(/waits for MEP-2026-0977 approval/);
  });

  it('puts open inspections and gating permits on the critical path; passed ones off it', () => {
    expect(t.criticalPath).toEqual(['I4', 'I5', 'I6', 'I7', 'I8']);
    expect(row('P3').critical).toBe(true);
    expect(row('P2').critical).toBe(false);
    expect(row('I1').state).toBe('done');
  });

  it('forecasts the finish and explains it', () => {
    expect(t.forecastFinish).not.toBeNull();
    expect(t.forecastFinish! > TODAY).toBe(true);
    expect(t.why).toMatch(/Driving the critical path/);
    expect(t.start < TODAY && t.end > t.forecastFinish!).toBe(true);
  });
});

describe('risk heatmap by trade and level', () => {
  const h = buildHeatmap(issues, { I5: 75, I6: 60, R4: 30, P3: 50, I2: 30 });
  it('builds trade x level cells with the highest risk in each', () => {
    expect(h.cells.find((c) => c.trade === 'Framing' && c.level === 'Level 2')).toMatchObject({ score: 75 });
    expect(h.cells.find((c) => c.trade === 'Electrical' && c.level === 'Level 2')).toMatchObject({ score: 60 });
    expect(h.max).toBe(75);
  });
  it('orders levels bottom-up and trades by total risk', () => {
    expect(h.levels.indexOf('Foundation')).toBe(0);
    expect(h.levels.indexOf('Level 1')).toBeLessThan(h.levels.indexOf('Level 2'));
    expect(h.trades[0]).toBe('Framing');
  });
});
