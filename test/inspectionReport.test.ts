import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/kvs', () => ({ kvs: {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import type { LlmProvider } from '../src/lib/llm';
import { FIELD_NOTES, ISSUES, PLAN_SHEETS } from '../src/seed/dataset';
import { adfToText, commentToEvidence } from '../src/services/inspectionData';
import { assembleReport, buildReportPrompt, EvidenceItem, generateReport, InspectionContext, LlmReport } from '../src/services/inspectionReport';
import { renderReportStorage, ReportRow } from '../src/services/reports';

const I2 = ISSUES.find((i) => i.seedId === 'I2')!;
const I5 = ISSUES.find((i) => i.seedId === 'I5')!;
const P1 = ISSUES.find((i) => i.seedId === 'P1')!;
const P2 = ISSUES.find((i) => i.seedId === 'P2')!;
const S101 = PLAN_SHEETS.find((s) => s.sheetId === 'S-101')!;
const A201 = PLAN_SHEETS.find((s) => s.sheetId === 'A-201')!;

const rebarNote = FIELD_NOTES.find((n) => n.issue === 'I2')!.text;
const framingNote = FIELD_NOTES.find((n) => n.issue === 'I5')!.text;

const rebarCtx: InspectionContext = {
  issueKey: 'FMD-6',
  summary: I2.summary,
  stage: 'Passed',
  scheduledFor: '2026-10-22',
  inspectedOn: '2026-10-22',
  contractor: 'Atlas Concrete',
  inspector: 'J. Ortiz',
  checklist: I2.checklist!,
  permit: { key: 'FMD-1', summary: P1.summary, stage: 'Approved', permitNo: P1.permitNo!, expiresOn: '2026-12-10', conditions: P1.conditions! },
  priorInspections: [{ key: 'FMD-5', summary: 'Footing inspection - Grid A-D / 1-6', stage: 'Passed' }],
  planSheets: [{ sheetId: 'S-101', title: S101.title, text: S101.text }],
  planFindings: [],
};

const rebarEvidence: EvidenceItem[] = [
  { id: 'note-100', kind: 'note', author: 'J. Ortiz (City inspector)', capturedAt: '2026-10-22T10:30:00.000Z', text: rebarNote },
  { id: 'photo-200', kind: 'photo', author: 'Day', capturedAt: '2026-11-25T00:00:00.000Z', filename: 'foundation-bottom-mat-gridB.jpg', exif: { dateTimeOriginal: '2026-10-22T10:10:00.000Z', lat: 34.02, lon: -117.39 } },
];

const rebarLlm: LlmReport = {
  observations: [
    { id: 'O1', evidenceId: 'note-100', quote: 'Bottom mat observed #4 bars @ 18 in. o.c. each way at grid B-C/2-3.', topic: 'bottom mat bars' },
    { id: 'O2', evidenceId: 'note-100', quote: 'Clear cover approximately 3 in. on chairs.', topic: 'clear cover' },
    { id: 'O3', evidenceId: 'note-100', quote: 'Lap splices measured 30 in.', topic: 'laps' }, // fabricated -> dropped
  ],
  lines: [
    {
      item: 'Bar size and spacing per S-101',
      status: 'conflict',
      observationIds: ['O1'],
      photoIds: ['photo-200'],
      planSheetId: 'S-101',
      planQuote: 'Footing bottom mat #5 bars @ 12 in. o.c. each way.',
      rationale: '#4 @ 18 in. observed vs #5 @ 12 in. required.',
    },
    { item: 'Clear cover 3 in. bottom', status: 'verified', observationIds: ['O2'], photoIds: [], planSheetId: 'S-101', planQuote: 'Clear cover 3 in. to earth.', rationale: '3 in. observed = 3 in. required.' },
    { item: 'Dowels and laps per S-101', status: 'verified', observationIds: ['O3'], photoIds: [], planSheetId: null, planQuote: null, rationale: 'Laps OK.' },
    {
      item: 'Reinforcement must match approved sheet S-101; field changes need engineer-of-record approval.',
      status: 'conflict',
      observationIds: ['O1'],
      photoIds: [],
      planSheetId: 'S-101',
      planQuote: 'REINFORCEMENT: Footing bottom mat #5 bars @ 12 in. o.c. each way.',
      rationale: 'Installed bars differ from S-101 with no recorded engineer approval.',
    },
  ],
  summary: 'Reinforcement does not match S-101.',
};

describe('assembleReport on the demo rebar inspection', () => {
  const rep = assembleReport(rebarCtx, rebarEvidence, rebarLlm, { today: '2026-11-26' });
  const line = (item: string) => rep.lines.find((l) => l.item.startsWith(item))!;

  it('flags the report-vs-plan contradiction as a Conflict with linked note, photo and plan quote', () => {
    const l = line('Bar size and spacing');
    expect(l.status).toBe('conflict');
    expect(l.evidence.map((e) => e.type).sort()).toEqual(['observation', 'photo', 'plan']);
    expect(l.evidence.find((e) => e.type === 'photo')!.capturedAt).toBe('2026-10-22T10:10:00.000Z');
    expect(l.evidence.find((e) => e.type === 'plan')!.quote).toContain('#5 bars @ 12 in.');
    expect(rep.recommendation).toBe('conflicts_found');
  });

  it('keeps verified lines only when a verbatim field observation supports them', () => {
    expect(line('Clear cover').status).toBe('verified');
    expect(rep.observations.map((o) => o.id)).toEqual(['O1', 'O2']);
    expect(rep.dropped).toContainEqual({ what: 'observation O3', reason: 'quote not found in source note' });
    const laps = line('Dowels and laps');
    expect(laps.status).toBe('needs_review');
    expect(laps.rationale).toMatch(/Downgraded/);
  });

  it('covers every checklist item and permit condition, defaulting to Needs review', () => {
    for (const c of [...rebarCtx.checklist, ...rebarCtx.permit!.conditions]) expect(rep.lines.some((l) => l.item === c)).toBe(true);
    expect(line('Chairs and ties secure').status).toBe('needs_review');
    expect(line('Reinforcement must match').evidence.some((e) => e.type === 'permit')).toBe(true);
  });

  it('adds deterministic sequence and permit lines', () => {
    expect(rep.lines.find((l) => l.kind === 'prior_inspection')!.status).toBe('verified');
    expect(rep.lines.find((l) => l.kind === 'permit')!.status).toBe('verified');
  });

  it('never recommends a pass and counts add up', () => {
    expect(['ready_for_signoff', 'needs_review', 'conflicts_found']).toContain(rep.recommendation);
    expect(rep.counts.verified + rep.counts.needs_review + rep.counts.conflict).toBe(rep.lines.length);
    expect(rep.summary).toMatch(/Inspector sign-off required/);
  });
});

describe('deterministic checks on the framing inspection', () => {
  const ctx: InspectionContext = {
    ...rebarCtx,
    issueKey: 'FMD-9',
    summary: I5.summary,
    stage: 'Scheduled',
    scheduledFor: '2026-11-29',
    inspectedOn: null,
    checklist: I5.checklist!,
    permit: { key: 'FMD-2', summary: P2.summary, stage: 'Approved', permitNo: P2.permitNo!, expiresOn: '2026-12-10', conditions: [] },
    priorInspections: [{ key: 'FMD-8', summary: 'Slab on grade pre-pour inspection - Level 1', stage: 'Scheduled' }],
    planSheets: [{ sheetId: 'A-201', title: A201.title, text: A201.text }],
  };
  const evidence: EvidenceItem[] = [
    { id: 'note-1', kind: 'note', author: 'R. Diaz', capturedAt: '2026-11-25T10:30:00Z', text: framingNote },
    { id: 'photo-1', kind: 'photo', author: null, capturedAt: null, filename: 'no-exif.jpg', exif: null },
    { id: 'photo-2', kind: 'photo', author: null, capturedAt: null, filename: 'old.jpg', exif: { dateTimeOriginal: '2026-08-01T09:00:00Z' } },
  ];
  const rep = assembleReport(ctx, evidence, { observations: [], lines: [], summary: '' }, { today: '2026-11-26' });

  it('marks the out-of-sequence prerequisite as a Conflict', () => {
    const l = rep.lines.find((x) => x.kind === 'prior_inspection')!;
    expect(l.status).toBe('conflict');
    expect(l.rationale).toMatch(/FMD-8 is Scheduled/);
  });

  it('flags a permit expiring within 21 days of the inspection', () => {
    expect(rep.lines.find((x) => x.kind === 'permit')!.status).toBe('needs_review');
  });

  it('flags photos without EXIF or taken far from the inspection date', () => {
    const photoLines = rep.lines.filter((x) => x.kind === 'photo');
    expect(photoLines.map((p) => p.item)).toEqual(['Photo metadata: no-exif.jpg', 'Photo timing: old.jpg']);
    expect(photoLines.every((p) => p.status === 'needs_review')).toBe(true);
  });

  it('flags a permit that is not approved', () => {
    const r2 = assembleReport({ ...ctx, permit: { ...ctx.permit!, stage: 'In Review' } }, [], { observations: [], lines: [], summary: '' }, { today: '2026-11-26' });
    expect(r2.lines.find((x) => x.kind === 'permit')!.status).toBe('conflict');
  });
});

describe('generateReport end to end with a scripted model', () => {
  it('sends the checklist, plan text, notes and photo metadata, then validates the answer', async () => {
    let prompt = '';
    const provider: LlmProvider = {
      async chat(req) {
        prompt = req.messages.find((m) => m.role === 'user')!.content;
        return { text: '', toolCalls: [{ id: 't', name: 'write_report', arguments: rebarLlm }], finishReason: 'tool_use', usage: { input: 900, output: 300 } };
      },
    };
    const rep = await generateReport(rebarCtx, rebarEvidence, { provider, today: '2026-11-26' });
    expect(prompt).toContain('Bar size and spacing per S-101');
    expect(prompt).toContain('#5 bars @ 12 in. o.c. each way');
    expect(prompt).toContain('[photo-200] foundation-bottom-mat-gridB.jpg taken 2026-10-22T10:10:00.000Z');
    expect(prompt).toContain('image content is not available');
    expect(rep.usage).toEqual({ input: 900, output: 300 });
    expect(rep.counts.conflict).toBeGreaterThanOrEqual(2);
  });

  it('builds a prompt that says when there is no evidence', () => {
    expect(buildReportPrompt({ ...rebarCtx, permit: null }, [])).toMatch(/FIELD NOTES AND TRANSCRIPTS:\n\(none\)/);
  });
});

describe('Jira comment parsing', () => {
  const body = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Voice note transcript - R. Diaz (2026-11-26 10:30 UTC)' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Boxes are set on the east wing.' }] },
    ],
  };
  it('turns Foreman-formatted comments into timestamped evidence', () => {
    expect(adfToText(body)).toBe('Voice note transcript - R. Diaz (2026-11-26 10:30 UTC)\nBoxes are set on the east wing.\n');
    expect(commentToEvidence({ id: '7', created: '2026-11-26T11:00:00Z', body })).toEqual({
      id: 'note-7',
      kind: 'transcript',
      author: 'R. Diaz',
      capturedAt: '2026-11-26T10:30:00.000Z',
      text: 'Boxes are set on the east wing.',
    });
  });
  it('accepts plain comments and ignores Foreman system comments', () => {
    const plain = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sheathing nailed at 6 in. edges.' }] }] };
    expect(commentToEvidence({ id: '8', created: '2026-11-26T11:00:00Z', author: { displayName: 'Ann' }, body: plain })).toMatchObject({ kind: 'note', author: 'Ann' });
    const sys = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Foreman] Report ready' }] }] };
    expect(commentToEvidence({ id: '9', created: '2026-11-26T11:00:00Z', body: sys })).toBeNull();
  });
});

describe('Confluence page rendering', () => {
  const rep = assembleReport(rebarCtx, rebarEvidence, rebarLlm, { today: '2026-11-26' });
  const row: ReportRow = {
    id: 1, projectKey: 'FMD', issueKey: 'FMD-6', version: 2, state: 'awaiting_signoff', report: rep,
    confluencePageId: null, confluenceUrl: null, createdAt: '', publishedAt: null, signedBy: null, signedAt: null, signoffNote: null,
  };
  it('renders status lozenges, evidence and a pending sign-off block', () => {
    const html = renderReportStorage(row, 'https://example.atlassian.net/browse/FMD-6');
    expect(html).toContain('<ac:parameter ac:name="title">CONFLICT</ac:parameter>');
    expect(html).toContain('CONFLICTS FOUND');
    expect(html).toContain('PENDING');
    expect(html).toContain('#5 bars @ 12 in.');
  });
  it('escapes HTML from evidence text', () => {
    const evil = { ...row, report: { ...rep, summary: '<script>alert(1)</script>' } };
    expect(renderReportStorage(evil, 'u')).not.toContain('<script>');
  });
  it('renders the inspector decision', () => {
    const html = renderReportStorage(row, 'u', { decision: 'approved', by: 'J. Ortiz', at: '2026-11-26T12:00:00Z', note: 'Corrected in field' });
    expect(html).toContain('APPROVED');
    expect(html).toContain('J. Ortiz');
  });
});
