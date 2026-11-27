import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/kvs', () => ({ kvs: {}, WhereConditions: {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import { ProjectMeta } from '../src/lib/schemas';
import { RULES } from '../src/rules';
import { parseCsv, portalRecords } from '../src/seed/cityPortal';
import { PLAN_SHEETS, PROJECT_META } from '../src/seed/dataset';
import { commentToEvidence } from '../src/services/inspectionData';
import { buildReportPrompt } from '../src/services/inspectionReport';
import { buildUserPrompt, selectRules } from '../src/services/planReview';
import { toGraphObject } from '../src/services/twg/connector';
import { contextAsText, extractDecisions, GraphContext, rankDocs, rankSimilar, relevantPortal } from '../src/services/twg/context';
import { DEMO_DECISIONS } from '../src/services/twg/focus';

const NOW = new Date('2026-11-26T12:00:00Z');
const KEYS = { P1: 'FMD-1', P2: 'FMD-2', P3: 'FMD-3', I1: 'FMD-5', I2: 'FMD-6', I3: 'FMD-7', I5: 'FMD-9' };

describe('mock city permit portal', () => {
  it('parses the CSV export including quoted fields with commas', () => {
    expect(parseCsv('a,b\n1,"x, y"\n')).toEqual([['a', 'b'], ['1', 'x, y']]);
    const recs = portalRecords();
    expect(recs).toHaveLength(9);
    expect(recs[0]).toMatchObject({ recordId: 'CR-24019', permitNo: 'MEP-2026-0977', jira: 'P3', dayOffset: -9 });
    expect(recs[0].detail).toContain('panels L2A/L2B and revise');
    expect(recs.filter((r) => !r.jira).map((r) => r.project)).toEqual(['Sunset Lofts', 'Sunset Lofts']);
  });
});

describe('Teamwork Graph connector objects', () => {
  const [planCheck] = portalRecords();
  const obj = toGraphObject(planCheck, KEYS, NOW, 42);

  it('maps a portal record to an atlassian:work-item linked to its Jira permit and the city official', () => {
    expect(obj).toMatchObject({
      schemaVersion: '2.0',
      id: 'riverside-portal-CR-24019',
      updateSequenceNumber: 42,
      url: 'https://permits.riverside-demo.example/records/CR-24019',
      createdAt: '2026-11-17T12:00:00.000Z',
      createdBy: { externalId: 'riverside-m-chen', email: 'mchen@riverside-demo.example' },
      'atlassian:work-item': { status: 'Comments issued', subtype: 'approval', team: 'City plan check' },
    });
    expect(obj.associations!.set).toEqual([{ associationType: 'issueIdOrKeys', values: ['FMD-3'] }]);
    expect(obj.permissions[0].accessControls[0].principals[0].type).toBe('ATLASSIAN_WORKSPACE');
    expect(obj.displayName.length).toBeGreaterThan(10);
    expect(obj.description.length).toBeGreaterThan(10);
  });

  it('records from other projects are ingested without a Jira association', () => {
    const history = portalRecords().find((r) => r.recordId === 'CR-19877')!;
    const o = toGraphObject(history, KEYS, NOW, 1);
    expect(o.associations).toBeUndefined();
    expect(o['atlassian:work-item'].subtype).toBe('task');
  });

  it('stays within setObjects limits (<=100 objects, required fields present)', () => {
    const all = portalRecords().map((r) => toGraphObject(r, KEYS, NOW, 1));
    expect(all.length).toBeLessThanOrEqual(100);
    for (const o of all) for (const f of ['id', 'displayName', 'description', 'url', 'createdAt', 'lastUpdatedAt'] as const) expect(o[f]).toBeTruthy();
  });
});

describe('reading context out of the graph', () => {
  const comments = [
    { issueKey: 'FMD-15', author: 'Day Nguyen', content: DEMO_DECISIONS[0].text, at: '2026-11-25T10:00:00Z', url: null },
    { issueKey: 'FMD-9', author: 'Day Nguyen', content: 'Field note - R. Diaz (2026-11-25 10:30 UTC) corridor framed', at: null, url: null },
    { issueKey: 'FMD-9', author: 'Foreman', content: '[Foreman monitor] HIGH: must reschedule', at: null, url: null },
    { issueKey: 'FMD-3', author: 'Ann Lee', content: 'City approved the revised riser diagram.', at: null, url: null },
    { issueKey: 'FMD-3', author: 'Ann Lee', content: 'Lunch order is in.', at: null, url: null },
  ];

  it('extracts decisions, naming the decider written in the record', () => {
    const d = extractDecisions(comments);
    expect(d.map((x) => [x.issueKey, x.who])).toEqual([
      ['FMD-15', 'M. Chen'],
      ['FMD-3', 'Ann Lee'],
    ]);
  });

  it('ranks spec pages and similar work by relevance to the item', () => {
    const docs = rankDocs(
      [
        { title: 'Riverside Commons - Rated corridor assemblies and firestopping (spec v3)', url: 'u1', owner: 'Day' },
        { title: 'Team offsite agenda', url: 'u2', owner: 'Day' },
        { title: 'Riverside Commons - Foundation reinforcement and framing hold-downs (structural notes)', url: 'u3', owner: 'Day' },
      ],
      'Framing inspection - Levels 2-3 hold-down corridor wall',
    );
    expect(docs.map((d) => d.url)).toEqual(['u1', 'u3']);
    const sim = rankSimilar(
      [
        { key: 'FMD-9', summary: 'Framing inspection - Levels 2-3', status: 'In Progress', resolvedAt: null },
        { key: 'FMD-14', summary: 'RFI-2 Shear wall hold-down at grid C/4', status: 'Backlog', resolvedAt: null },
        { key: 'FMD-21', summary: 'Replace damaged sill plate at grid D/6', status: 'Backlog', resolvedAt: null },
      ],
      { key: 'FMD-9', summary: 'Framing inspection hold-down shear wall' },
    );
    expect(sim.map((s) => s.key)).toEqual(['FMD-14']);
  });

  it('finds city records for the item and precedent from earlier projects', () => {
    const mep = relevantPortal(['P3'], 'P-3 MEP permit', NOW);
    expect(mep.map((r) => r.recordId)).toEqual(expect.arrayContaining(['CR-24019', 'CR-24020', 'CR-20112']));
    const framing = relevantPortal(['I5'], 'Framing inspection hold-downs', NOW);
    expect(framing.map((r) => r.recordId)).toEqual(expect.arrayContaining(['CR-24055', 'CR-19877']));
    expect(framing.find((r) => r.recordId === 'CR-19877')!.detail).toMatch(/6 days later/);
  });

  it('renders a compact context block for prompts', () => {
    const ctx: GraphContext = {
      available: true,
      focusKey: 'FMD-9',
      people: [{ id: 'u', name: 'Day Nguyen', roles: ['commented on FMD-9'] }],
      decisions: extractDecisions(comments),
      docs: [{ title: 'Spec v3', url: null, owner: 'Day Nguyen', score: 2 }],
      similar: [],
      portal: relevantPortal(['I5'], 'Framing inspection hold-downs', NOW),
      connector: { connected: true, lastSync: null, accepted: 9 },
      fetchedAt: NOW.toISOString(),
    };
    const text = contextAsText(ctx);
    expect(text).toContain('Decisions on record:');
    expect(text).toContain('- M. Chen on FMD-15');
    expect(text).toContain('Relevant Confluence docs:');
    expect(text).toContain('Sunset Lofts');
  });
});

describe('graph context reaches findings and reports', () => {
  const meta = ProjectMeta.parse(PROJECT_META);
  const a201 = PLAN_SHEETS.find((s) => s.sheetId === 'A-201')!;
  const notes = ['M. Chen on FMD-15: W2 accepted as UL U419 only if both sides boarded.'];

  it('plan review prompt carries decisions, clearly marked as context not evidence', () => {
    const p = buildUserPrompt(a201, meta, selectRules(RULES, meta, 'Architectural').slice(0, 2), notes);
    expect(p).toContain('PROJECT DECISIONS AND RECORDS (from Teamwork Graph');
    expect(p).toContain('never as evidence quotes');
    expect(p).toContain('W2 accepted as UL U419');
    expect(buildUserPrompt(a201, meta, [], [])).not.toContain('PROJECT DECISIONS');
  });

  it('report prompt carries decisions and city records', () => {
    const ctx = { issueKey: 'FMD-9', summary: 's', stage: 'Scheduled', scheduledFor: null, inspectedOn: null, contractor: null, inspector: null, checklist: [], permit: null, priorInspections: [], planSheets: [], planFindings: [] };
    expect(buildReportPrompt(ctx, [], notes)).toContain('DECISIONS AND CITY RECORDS (Teamwork Graph; context only, not field evidence):');
  });

  it('decision records are not mistaken for field evidence', () => {
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: DEMO_DECISIONS[1].text }] }] };
    expect(commentToEvidence({ id: '1', created: NOW.toISOString(), body })).toBeNull();
  });
});
