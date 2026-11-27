/**
 * Builds fixtures for the local UI preview harness (static/ui/src/dev) by running Foreman's real
 * pure services (monitor, timeline, heatmap, plan review validation, report assembly) on the demo
 * dataset. Only the LLM answers are scripted. Run: npx tsx scripts/ui-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectMeta } from '../src/lib/schemas';
import { RULES } from '../src/rules';
import { DEMO_PHOTOS } from '../src/seed/photos.generated';
import { buildIssues, FIELD_NOTES, ISSUES, LINKS, PLAN_SHEETS, PROJECT_META, stageCategory } from '../src/seed/dataset';
import { DEFAULT_CONFIG, DETECTOR_LABELS, DETECTORS } from '../src/services/monitor/config';
import { detect, MonIssue } from '../src/services/monitor/detect';
import { digestText } from '../src/services/monitor/digest';
import { assembleReport, InspectionContext } from '../src/services/inspectionReport';
import { selectRules, validateFindings } from '../src/services/planReview';
import { relevantPortal } from '../src/services/twg/context';
import { DEMO_DECISIONS } from '../src/services/twg/focus';
import { buildHeatmap, buildTimeline } from '../src/services/visuals';

const OUT = join(__dirname, '..', 'static', 'ui', 'src', 'dev');
const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const SEED = new Date(NOW.getTime() - 86_400_000);
const order = ISSUES.map((i) => i.seedId);
const key = (seed: string) => `FMD-${order.indexOf(seed) + 1}`;
const built = buildIssues(SEED);

const issues: MonIssue[] = built.map((b) => ({
  key: key(b.seedId),
  id: String(10000 + order.indexOf(b.seedId)),
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
  openedOn: b.dates.openedOn ?? null,
  inspectedOn: b.dates.inspectedOn ?? null,
  contractor: b.contractor === 'volt' ? 'Volt MEP' : b.contractor === 'keystone' ? 'Keystone Framing' : b.contractor ? 'Atlas Concrete' : null,
  assignment: b.assignment ? { contractor: 'Volt MEP', assignedAt: b.assignmentAt, acknowledgedAt: null } : null,
  requiresPrior: LINKS.filter((l) => l.kind === 'requiresPrior' && l.from === b.seedId).map((l) => key(l.to)),
  governedBy: LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId) ? key(LINKS.find((l) => l.kind === 'governedBy' && l.from === b.seedId)!.to) : null,
  blocks: LINKS.filter((l) => l.kind === 'blocks' && l.from === b.seedId).map((l) => key(l.to)),
  sheets: b.sheets ?? [],
  conditions: b.conditions ?? [],
  latestReport: null,
}));
const notesByIssue: Record<string, string[]> = {};
for (const n of FIELD_NOTES) (notesByIssue[key(n.issue)] ??= []).push(n.text);

const res = detect(
  { projectKey: 'FMD', jurisdiction: PROJECT_META.jurisdiction, today, now: NOW.toISOString(), issues, openFailFindingsBySheet: {}, notesByIssue, planTextBySheet: Object.fromEntries(PLAN_SHEETS.map((s) => [s.sheetId, s.text])) },
  DEFAULT_CONFIG,
);
const pending = res.problems.map((p, i) => ({
  id: i + 1,
  projectKey: 'FMD',
  kind: p.proposal.kind,
  targetKey: (p.proposal.payload.issueKey as string) ?? p.issueKey,
  title: p.proposal.title,
  payload: p.proposal.payload,
  why: p.why,
  source: 'monitor',
  state: 'pending',
  dedupeKey: p.key,
  createdAt: NOW.toISOString(),
  decidedBy: null,
  decidedAt: null,
  result: null,
}));
pending.push({ ...pending[0], id: pending.length + 1, source: 'agent', kind: 'approval_packet', title: 'Record the approval packet on FMD-2 for project manager sign-off', targetKey: 'FMD-2', why: 'Approval packet drafted in Rovo chat (3 blockers).', payload: { issueKey: 'FMD-2' }, dedupeKey: 'agent:approval_packet:FMD-2' });
const riskByKey = Object.fromEntries(res.issueRisk.map((r) => [r.issueKey, r.score]));

const overview = {
  monitored: true,
  projectKey: 'FMD',
  projectName: 'Riverside Commons',
  risk: { projectKey: 'FMD', score: res.project.score, band: res.project.band, why: res.project.why, counts: res.project.counts, computedAt: NOW.toISOString(), problemCount: res.problems.length },
  problems: res.problems.map((p, i) => ({ key: p.key, detector: p.detector, detectorLabel: DETECTOR_LABELS[p.detector], issueKey: p.issueKey, severity: p.severity, points: p.points, title: p.title, why: p.why, proposalId: i + 1, firstSeen: NOW.toISOString() })),
  pending,
  recent: [],
  topRisk: [...res.issueRisk].sort((a, b) => b.score - a.score).slice(0, 6).filter((r) => r.score > 0).map((r) => ({ issueKey: r.issueKey, score: r.score, band: r.band, reasons: r.reasons })),
  digest: {
    date: today,
    text: digestText({
      projectKey: 'FMD',
      date: today,
      risk: { score: res.project.score, band: res.project.band, why: res.project.why },
      newProblems: res.problems.slice(0, 4).map((p) => ({ issueKey: p.issueKey, severity: p.severity, title: p.title })),
      openProblems: res.problems.map((p) => ({ issueKey: p.issueKey, severity: p.severity, title: p.title, ageDays: 1 })),
      resolved: [],
      pendingProposals: pending.slice(0, 6).map((p) => ({ id: p.id, title: p.title, targetKey: p.targetKey })),
      decisions: [],
    }),
  },
  config: DEFAULT_CONFIG,
  detectors: DETECTORS.map((d) => ({ id: d, label: DETECTOR_LABELS[d] })),
  lastJob: null,
};

const visuals = {
  timeline: buildTimeline(issues, today),
  heatmap: buildHeatmap(issues, riskByKey),
  issues: Object.fromEntries(issues.map((i) => [i.key, { summary: i.summary, kind: i.kind, stage: i.stage, risk: riskByKey[i.key] ?? 0 }])),
};

// ---- code review (FMD-9 / A-201) ----
const meta = ProjectMeta.parse(PROJECT_META);
const a201 = PLAN_SHEETS.find((s) => s.sheetId === 'A-201')!;
const archRules = selectRules(RULES, meta, 'Architectural');
const scripted: Record<string, [string, string, string?]> = {
  'EGR-1020.3': ['fail', 'Corridor clear width: 40 in. minimum at all residential corridors.', 'Widen residential corridors to 44 in. clear (112 occupants served).'],
  'EGR-1020.5': ['fail', 'West wing corridor terminates in a dead end 55 ft long beyond the last exit access point.', 'Reduce the west wing dead end to 50 ft or less, or add an exit access point.'],
  'EGR-1007.1.1': ['fail', 'Stair 1 and Stair 2 entrances are 38 ft apart measured in a straight line.', 'Separate the stair entrances by at least 60 ft (one-third of the 180 ft diagonal).'],
  'FIR-714.4': ['fail', 'Penetrations of rated corridor walls: see FP-101 (firestop systems to be submitted).', 'Specify listed firestop systems for rated corridor wall penetrations before rough-in cover.'],
  'EGR-1006.2.1': ['pass', 'Common path of egress travel from unit 214: 60 ft.'],
  'EGR-1017.2': ['pass', 'Max travel distance to an exit: 190 ft (sprinklered).'],
  'FIR-1020.2': ['pass', 'Corridor walls: 1-hour fire-resistance-rated, UL U419'],
  'FIR-716.2.2.1': ['pass', 'Corridor doors: 20-minute rated, self-closing, positive latching, 36 in. clear width.'],
  'ADA-404.2.7': ['pass', 'Door hardware: lever handles mounted 34-48 in. above finished floor.'],
  'FIR-1023.2': ['needs_review', 'Exits: two exit stairs, Stair 1 at grid A/1 and Stair 2 at grid A/3.', 'State the stair enclosure rating (2-hour required for 4+ stories).'],
};
const reasoning: Record<string, string> = {
  'EGR-1020.3': '40 in. provided < 44 in. required for an occupant load of 112 (50 or more).',
  'EGR-1020.5': '55 ft > 50 ft maximum for a sprinklered R-2 dead end.',
  'EGR-1007.1.1': '38 ft < 60 ft (1/3 of the 180 ft diagonal, sprinklered).',
  'FIR-714.4': 'Firestop systems are deferred ("to be submitted").',
};
const v = validateFindings(
  archRules.map((r) => {
    const s = scripted[r.id];
    return s
      ? { ruleId: r.id, status: s[0] as 'pass', evidenceQuote: s[1], confidence: 0.9, suggestedFix: s[2] ?? '', reasoning: reasoning[r.id] ?? '' }
      : { ruleId: r.id, status: 'not_applicable' as const, evidenceQuote: '', confidence: 0.9, suggestedFix: '', reasoning: '' };
  }),
  archRules,
  a201.text,
);
const findings = v.findings.map((f, i) => ({
  id: i + 1, projectKey: 'FMD', issueKey: 'FMD-9', sheetId: 'A-201', jobId: 1, ...f,
  state: i === 3 ? 'ticketed' : 'open', createdIssueKey: i === 3 ? 'FMD-26' : null, decidedBy: null, decidedAt: null, decisionNote: null, createdAt: NOW.toISOString(),
}));
const reviewContext = {
  issueKey: 'FMD-9',
  projectKey: 'FMD',
  issueType: 'Inspection',
  meta,
  sheets: PLAN_SHEETS.map((s) => ({ sheetId: s.sheetId, title: s.title, discipline: s.discipline, source: 'demo', suggested: s.sheetId === 'A-201', ruleCount: selectRules(RULES, meta, s.discipline).length })),
  pdfAttachments: [],
  findings,
  job: null,
  rulePack: { version: '2026.11-1', total: RULES.length },
};

// ---- evidence report (FMD-6 rebar) ----
const I2 = ISSUES.find((i) => i.seedId === 'I2')!;
const P1 = ISSUES.find((i) => i.seedId === 'P1')!;
const S101 = PLAN_SHEETS.find((s) => s.sheetId === 'S-101')!;
const rebarNote = FIELD_NOTES.find((n) => n.issue === 'I2')!.text;
const ctx: InspectionContext = {
  issueKey: 'FMD-6', summary: I2.summary, stage: 'Passed', scheduledFor: built.find((b) => b.seedId === 'I2')!.dates.scheduledFor!, inspectedOn: built.find((b) => b.seedId === 'I2')!.dates.inspectedOn!,
  contractor: 'Atlas Concrete', inspector: 'J. Ortiz', checklist: I2.checklist!,
  permit: { key: 'FMD-1', summary: P1.summary, stage: 'Approved', permitNo: P1.permitNo!, expiresOn: built.find((b) => b.seedId === 'P1')!.dates.expiresOn!, conditions: P1.conditions! },
  priorInspections: [{ key: 'FMD-5', summary: 'Footing inspection - Grid A-D / 1-6', stage: 'Passed' }],
  planSheets: [{ sheetId: 'S-101', title: S101.title, text: S101.text }], planFindings: [],
};
const photoTaken = new Date(Date.parse(`${ctx.inspectedOn}T10:10:00Z`)).toISOString();
const report = assembleReport(
  ctx,
  [
    { id: 'note-100', kind: 'note', author: 'J. Ortiz (City inspector)', capturedAt: `${ctx.inspectedOn}T10:30:00.000Z`, text: rebarNote },
    { id: 'photo-201', kind: 'photo', author: 'Day', capturedAt: NOW.toISOString(), filename: 'foundation-bottom-mat-gridB.jpg', exif: { dateTimeOriginal: photoTaken, lat: 34.022, lon: -117.39 } },
  ],
  {
    observations: [
      { id: 'O1', evidenceId: 'note-100', quote: 'Bottom mat observed #4 bars @ 18 in. o.c. each way at grid B-C/2-3.', topic: 'Bottom mat bar size and spacing' },
      { id: 'O2', evidenceId: 'note-100', quote: 'Clear cover approximately 3 in. on chairs.', topic: 'Clear cover' },
      { id: 'O3', evidenceId: 'note-100', quote: 'Dowels in place.', topic: 'Dowels' },
    ],
    lines: [
      { item: 'Bar size and spacing per S-101', status: 'conflict', observationIds: ['O1'], photoIds: ['photo-201'], planSheetId: 'S-101', planQuote: 'Footing bottom mat #5 bars @ 12 in. o.c. each way.', rationale: '#4 @ 18 in. observed vs #5 @ 12 in. required by S-101.' },
      { item: 'Clear cover 3 in. bottom', status: 'verified', observationIds: ['O2'], photoIds: ['photo-201'], planSheetId: 'S-101', planQuote: 'Clear cover 3 in. to earth.', rationale: 'About 3 in. observed; 3 in. required.' },
      { item: 'Dowels and laps per S-101', status: 'needs_review', observationIds: ['O3'], photoIds: [], planSheetId: 'S-101', planQuote: 'DOWELS: #5 @ 16 in. o.c. into podium walls, lap 30 in.', rationale: 'Dowels noted but size, spacing and lap length were not recorded.' },
      { item: P1.conditions![1], status: 'conflict', observationIds: ['O1'], photoIds: [], planSheetId: 'S-101', planQuote: 'REINFORCEMENT: Footing bottom mat #5 bars @ 12 in. o.c. each way.', rationale: 'Installed bars differ from S-101 with no recorded engineer-of-record approval.' },
    ],
    summary: 'Reinforcement placement does not match S-101; the inspection is marked Passed in Jira.',
  },
  { today },
);
const evidenceContext = {
  issueKey: 'FMD-6',
  stage: 'Passed',
  kind: 'Inspection',
  checklistCount: I2.checklist!.length,
  notes: [{ id: 'note-100', kind: 'note', author: 'J. Ortiz (City inspector)', capturedAt: `${ctx.inspectedOn}T10:30:00.000Z`, excerpt: rebarNote }],
  photos: [{ id: '201', filename: 'foundation-bottom-mat-gridB.jpg', size: 45989, created: NOW.toISOString() }],
  report: { id: 3, version: 1, state: 'draft', confluenceUrl: null, signedAt: null, signoffNote: null, report },
  job: null,
};

// ---- Teamwork Graph context (FMD-9) ----
const graph = {
  available: true,
  focusKey: 'FMD-9',
  people: [
    { id: 'u1', name: 'Day Nguyen', roles: ['commented on FMD-9', 'reporter of FMD-9', 'commented on FMD-14'] },
    { id: 'u2', name: 'Riley Diaz', roles: ['assignee of FMD-14'] },
  ],
  decisions: [
    { issueKey: 'FMD-9', who: 'A. Patel', text: DEMO_DECISIONS[1].text, at: NOW.toISOString(), url: null },
    { issueKey: 'FMD-15', who: 'M. Chen', text: DEMO_DECISIONS[0].text, at: NOW.toISOString(), url: null },
  ],
  docs: [
    { title: 'Riverside Commons - Foundation reinforcement and framing hold-downs (structural notes)', url: 'https://example.atlassian.net/wiki/x', owner: 'Day Nguyen', score: 3 },
    { title: 'Riverside Commons - Rated corridor assemblies and firestopping (spec v3)', url: 'https://example.atlassian.net/wiki/y', owner: 'Day Nguyen', score: 2 },
  ],
  similar: [{ key: 'FMD-14', summary: 'RFI-2 Shear wall hold-down at grid C/4', status: 'Backlog', resolvedAt: null }],
  portal: relevantPortal(['I5', 'I4'], 'Framing inspection - Levels 2-3 hold-downs', NOW),
  connector: { connected: true, lastSync: NOW.toISOString(), accepted: 9 },
  fetchedAt: NOW.toISOString(),
};
const briefings = {
  ok: true,
  without: {
    headline: 'Framing inspection FMD-9 is scheduled before the slab inspection it depends on.',
    points: ['Scheduled for Nov 28; prerequisite slab inspection FMD-8 is still scheduled.', 'RFI-2 on the grid C/4 hold-down is open and blocks it.', 'Keystone Framing is the contractor.'],
    nextStep: 'Reschedule FMD-9 after FMD-8 passes.',
    talkTo: [],
  },
  withGraph: {
    headline: 'Framing FMD-9 will fail if booked before slab passes and before the ASI-04 hold-down is installed.',
    points: [
      'Slab inspection FMD-8 must pass first; the city portal notes the same (CR-24055).',
      'A. Patel (architect) moved the C/4 hold-down to C/4.5 in ASI-04; Keystone must install it before the inspection.',
      'Precedent: Sunset Lofts failed framing for missing hold-downs and re-inspection took 6 days.',
      'M. Chen accepted wall W2 as UL U419 only with gypsum on both sides; corridor side is still open.',
    ],
    nextStep: 'Approve proposal #1 to reschedule FMD-9, and ask Keystone to confirm the ASI-04 hold-down and corridor gypsum before the new date.',
    talkTo: ['A. Patel (architect)', 'M. Chen (City Fire Prevention)', 'Keystone Framing'],
  },
};

const fixtures = {
  status: { ok: true, version: '0.8.0', accountId: 'demo', projectKey: 'FMD', issueKey: null, serverTime: NOW.toISOString() },
  overview,
  visuals,
  onboardingNew: { dismissed: false, steps: { demoLoaded: false, monitorRan: false, reportDrafted: false, agentUsed: false, connectorConnected: false } },
  onboardingLoaded: { dismissed: false, steps: { demoLoaded: true, monitorRan: true, reportDrafted: false, agentUsed: false, connectorConnected: false } },
  demoStatusNew: { projectKey: 'FMD', loaded: false, completed: [], steps: ['config', 'project', 'issues', 'workflow', 'links', 'evidence', 'finalize'].map((id, i) => ({ id, label: ['Create issue types, link types and screens', 'Create the Riverside Commons project', 'Create permits, inspections, RFIs and punch items', 'Set issue statuses', 'Link inspection sequence, permits and blockers', 'Add plan sheets, field notes and photos', 'Finish'][i], done: false })), issueCount: 0 },
  reviewContext,
  evidenceContext,
  graph,
  briefings,
  audit: [
    { id: 3, ts: NOW.toISOString(), actorKind: 'monitor', action: 'monitor.scan', target: 'FMD' },
    { id: 2, ts: NOW.toISOString(), actorKind: 'user', action: 'finding.create_issue', target: 'FMD-9' },
    { id: 1, ts: NOW.toISOString(), actorKind: 'user', action: 'demo.loaded', target: 'FMD' },
  ],
};
mkdirSync(join(OUT, 'photos'), { recursive: true });
writeFileSync(join(OUT, 'fixtures.json'), JSON.stringify(fixtures, null, 1));
for (const p of DEMO_PHOTOS) writeFileSync(join(OUT, 'photos', `${p.id}.jpg`), Buffer.from(p.base64, 'base64'));
console.log(`fixtures: ${res.problems.length} problems, ${findings.length} findings, ${report.lines.length} report lines -> ${OUT}`);
