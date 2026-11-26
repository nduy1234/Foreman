import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/kvs', () => ({ kvs: {}, WhereConditions: {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../src/lib/audit', () => ({ audit: vi.fn(async () => 1) }));

const proposals = vi.hoisted(() => ({
  getProposal: vi.fn(),
  decideProposal: vi.fn(),
  listProposals: vi.fn(async () => []),
  upsertProposal: vi.fn(async () => ({ id: 7, created: true })),
}));
vi.mock('../src/services/proposals', () => proposals);

import { approvePending, buildResolutionPayload } from '../src/actions';
import { buildPermitPacket } from '../src/actions/packet';
import { resolveIssueRef, resolveProjectKey } from '../src/actions/resolve';
import { buildIssues, LINKS, stageCategory } from '../src/seed/dataset';
import { DEFAULT_CONFIG } from '../src/services/monitor/config';
import { detect, MonIssue, Snapshot } from '../src/services/monitor/detect';

const SEED = new Date('2026-11-25T15:00:00Z');
const keyOf = (seed: string) => `FMD-${['P1', 'P2', 'P3', 'P4', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'R1', 'R2', 'R3', 'R4', 'R5', 'PI1', 'PI2', 'PI3', 'PI4', 'PI5', 'CF1', 'CF2', 'CF3'].indexOf(seed) + 1}`;

const issues: MonIssue[] = buildIssues(SEED).map((b) => ({
  key: keyOf(b.seedId),
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
  contractor: b.contractor === 'volt' ? 'Volt MEP' : b.contractor === 'keystone' ? 'Keystone Framing' : b.contractor ? 'Atlas Concrete' : null,
  assignment: null,
  requiresPrior: LINKS.filter((l) => l.kind === 'requiresPrior' && l.from === b.seedId).map((l) => keyOf(l.to)),
  governedBy: LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId) ? keyOf(LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId)!.to) : null,
  blocks: LINKS.filter((l) => l.kind === 'blocks' && l.from === b.seedId).map((l) => keyOf(l.to)),
  sheets: b.sheets ?? [],
  conditions: b.conditions ?? [],
  latestReport: null,
}));

describe('resolving what the user means', () => {
  it.each([
    ['framing inspection', 'FMD-9'],
    ["What's blocking our framing inspection?", 'FMD-9'],
    ['permit P-2', 'FMD-2'],
    ['P-2', 'FMD-2'],
    ['RFI-4', 'FMD-16'],
    ['rebar inspection', 'FMD-6'],
    ['fmd-10', 'FMD-10'],
    ['MEP permit', 'FMD-3'],
  ])('"%s" -> %s', (ref, key) => {
    expect(resolveIssueRef(ref, issues)?.key).toBe(key);
  });

  it('returns null when nothing matches', () => {
    expect(resolveIssueRef('elevator inspection', issues)).toBeNull();
  });

  it('prefers platform context over model-supplied project keys', () => {
    expect(resolveProjectKey({ projectKey: 'XYZ', context: { jira: { issueKey: 'FMD-9' } } })).toBe('FMD');
    expect(resolveProjectKey({ projectKey: 'fmd' })).toBe('FMD');
  });
});

describe('approval packet for permit P-2', () => {
  const snapshot: Snapshot = {
    projectKey: 'FMD',
    jurisdiction: 'City of Riverside (demo)',
    today: '2026-11-25',
    now: SEED.toISOString(),
    issues,
    openFailFindingsBySheet: {},
    notesByIssue: {},
    planTextBySheet: {},
  };
  const res = detect(snapshot, DEFAULT_CONFIG);
  const permit = issues.find((i) => i.key === 'FMD-2')!;
  const inspections = issues.filter((i) => i.governedBy === 'FMD-2');
  const keys = new Set(['FMD-2', ...inspections.map((i) => i.key)]);
  const packet = buildPermitPacket({
    permit,
    conditions: permit.conditions!,
    inspections,
    openFindings: [{ ruleId: 'EGR-1020.3', title: 'Minimum corridor width', status: 'fail', sheetId: 'A-201', citation: 'IBC 2021 Section 1020.3' }],
    problems: res.problems.filter((p) => keys.has(p.issueKey)),
    jurisdiction: snapshot.jurisdiction,
    today: snapshot.today,
  });

  it('lists conditions, inspections, findings and risks', () => {
    const text = packet.lines.join('\n');
    expect(text).toContain('APPROVAL PACKET - P-2 Building permit');
    expect(text).toContain('BLD-2026-0413');
    expect(text).toContain('Hold-downs and shear wall nailing');
    expect(text).toContain('FMD-9 Framing inspection - Levels 2-3: Scheduled');
    expect(text).toContain('EGR-1020.3');
  });

  it('is not ready while the framing inspection is out of sequence and a code finding fails', () => {
    expect(packet.readiness).toBe('not_ready');
    expect(packet.blockers.some((b) => b.includes('FMD-9'))).toBe(true);
    expect(packet.blockers.some((b) => b.includes('EGR-1020.3'))).toBe(true);
  });
});

describe('proposal payloads from chat are validated', () => {
  const framing = issues.find((i) => i.key === 'FMD-9')!;
  it('reschedule needs a future YYYY-MM-DD date', () => {
    expect(buildResolutionPayload('reschedule', framing, { newDate: '2026-12-03', reason: 'after slab' }, '2026-11-26', 'City').payload).toMatchObject({ issueKey: 'FMD-9', to: '2026-12-03', from: '2026-11-28' });
    expect(() => buildResolutionPayload('reschedule', framing, { newDate: '2026-11-01', reason: 'x' }, '2026-11-26', 'City')).toThrow(/past/);
    expect(() => buildResolutionPayload('reschedule', framing, { newDate: 'next Tuesday', reason: 'x' }, '2026-11-26', 'City')).toThrow();
  });
  it('escalations default to the jurisdiction, notifications to the contractor', () => {
    expect(buildResolutionPayload('escalate', framing, { reason: 'stuck' }, '2026-11-26', 'City of Riverside (demo)').payload.to).toBe('City of Riverside (demo)');
    expect(buildResolutionPayload('notify', framing, { reason: 'confirm' }, '2026-11-26', 'City').payload.to).toBe('Keystone Framing');
  });
});

describe('approvePending only acts after explicit confirmation', () => {
  beforeEach(() => {
    proposals.getProposal.mockReset();
    proposals.decideProposal.mockReset();
  });

  it('without confirmation it only describes the proposal', async () => {
    proposals.getProposal.mockResolvedValue({ id: 12, projectKey: 'FMD', state: 'pending', title: 'Reschedule FMD-9 to Dec 2', why: 'w', kind: 'reschedule' });
    const r = await approvePending({ proposalId: 12, confirmed: false }, { accountId: 'u1' });
    expect(r).toMatchObject({ ok: true, needsConfirmation: true });
    expect(proposals.decideProposal).not.toHaveBeenCalled();
  });

  it('with confirmation it approves as the current user', async () => {
    proposals.getProposal.mockResolvedValue({ id: 12, projectKey: 'FMD', state: 'pending', title: 'Reschedule FMD-9', why: 'w', kind: 'reschedule' });
    proposals.decideProposal.mockResolvedValue({ state: 'executed', result: { rescheduledTo: '2026-12-02' } });
    const r = await approvePending({ proposalId: 12, confirmed: true }, { accountId: 'u1' });
    expect(proposals.decideProposal).toHaveBeenCalledWith(12, 'approve', 'u1', 'Approved in Rovo chat', 'FMD');
    expect(r).toMatchObject({ ok: true, state: 'executed' });
  });

  it('refuses proposals that are not pending and bad ids', async () => {
    proposals.getProposal.mockResolvedValue({ id: 3, projectKey: 'FMD', state: 'rejected', title: 't', why: 'w', kind: 'notify' });
    expect(await approvePending({ proposalId: 3, confirmed: true }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/already rejected/) });
    expect(await approvePending({ proposalId: 'abc', confirmed: true }, {})).toMatchObject({ ok: false });
    expect(proposals.decideProposal).not.toHaveBeenCalled();
  });
});
