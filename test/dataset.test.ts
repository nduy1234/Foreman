import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/kvs', () => ({ kvs: {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));

import {
  buildIssues,
  FIELD_NOTES,
  ISSUES,
  LINKS,
  PARTIES,
  PLAN_SHEETS,
  stageCategory,
} from '../src/seed/dataset';
import { demoPhoto, demoPhotoIds, exifDate } from '../src/seed/photos';
import { foremanProperty, linkPayload } from '../src/services/demoSeed';

const SEED = new Date('2026-12-01T15:00:00Z');
const built = buildIssues(SEED);
const byId = Object.fromEntries(built.map((i) => [i.seedId, i]));
const byType = (t: string) => built.filter((i) => i.type === t);

describe('demo dataset shape', () => {
  it('has ~25 issues with the requested mix', () => {
    expect(built).toHaveLength(25);
    expect(byType('Permit')).toHaveLength(4);
    expect(byType('Inspection')).toHaveLength(8);
    expect(byType('RFI').length).toBeGreaterThan(0);
    expect(byType('Punch Item').length).toBeGreaterThan(0);
    expect(byType('Code Finding').length).toBeGreaterThan(0);
  });

  it('has 3 contractors and 2 inspectors, all referenced ids exist', () => {
    expect(PARTIES.filter((p) => p.role === 'contractor')).toHaveLength(3);
    expect(PARTIES.filter((p) => p.role === 'inspector')).toHaveLength(2);
    const ids = new Set(PARTIES.map((p) => p.id));
    for (const i of ISSUES) {
      if (i.contractor) expect(ids.has(i.contractor)).toBe(true);
      if (i.inspector) expect(ids.has(i.inspector)).toBe(true);
    }
  });

  it('has unique seed ids and labels', () => {
    expect(new Set(ISSUES.map((i) => i.seedId)).size).toBe(ISSUES.length);
    for (const i of built) expect(i.labels).toEqual(['foreman-demo', `foreman-seed-${i.seedId.toLowerCase()}`]);
  });

  it('links reference existing issues and are unique', () => {
    const ids = new Set(ISSUES.map((i) => i.seedId));
    for (const l of LINKS) {
      expect(ids.has(l.from)).toBe(true);
      expect(ids.has(l.to)).toBe(true);
    }
    expect(new Set(LINKS.map((l) => `${l.kind}|${l.from}|${l.to}`)).size).toBe(LINKS.length);
  });

  it('inspection sequence covers footing -> rebar -> slab -> framing -> MEP rough-in -> fire -> final', () => {
    const chain = LINKS.filter((l) => l.kind === 'requiresPrior');
    const order = ['I1'];
    for (;;) {
      const next = chain.find((l) => l.to === order[order.length - 1]);
      if (!next) break;
      order.push(next.from);
    }
    const names = order.map((id) => byId[id].summary.toLowerCase());
    const expected = ['footing', 'rebar', 'slab', 'framing', 'mep rough-in', 'fire', 'final'];
    let cursor = 0;
    for (const word of expected) {
      const at = names.findIndex((n, idx) => idx >= cursor && n.includes(word));
      expect(at, `${word} in sequence`).toBeGreaterThanOrEqual(cursor);
      cursor = at + 1;
    }
    expect(order).toHaveLength(8);
  });

  it('every inspection is governed by a permit', () => {
    for (const i of byType('Inspection')) {
      expect(LINKS.some((l) => l.kind === 'governedBy' && l.from === i.seedId)).toBe(true);
    }
  });

  it('dates are relative to the seed day', () => {
    expect(byId.P3.dates.submittedOn).toBe('2026-11-19');
    expect(byId.I5.dates.scheduledFor).toBe('2026-12-04');
  });
});

describe('planted problems', () => {
  const days = (iso?: string) => (iso ? Math.round((Date.parse(iso) - Date.parse(SEED.toISOString().slice(0, 10))) / 86400000) : NaN);

  it('A: framing scheduled before its prerequisite slab inspection passes', () => {
    expect(byId.I4.stage).not.toBe('Passed');
    expect(days(byId.I5.dates.scheduledFor)).toBeLessThan(days(byId.I4.dates.scheduledFor));
    expect(LINKS).toContainEqual({ kind: 'requiresPrior', from: 'I5', to: 'I4' });
  });

  it('B: a permit stuck in review 12 days', () => {
    expect(byId.P3.stage).toBe('In Review');
    expect(days(byId.P3.dates.submittedOn)).toBe(-12);
  });

  it('C: rebar report contradicts plan S-101 while the inspection is Passed', () => {
    const note = FIELD_NOTES.find((n) => n.issue === 'I2')!;
    const s101 = PLAN_SHEETS.find((p) => p.sheetId === 'S-101')!;
    expect(byId.I2.stage).toBe('Passed');
    expect(s101.text).toContain('#5 bars @ 12 in. o.c. each way');
    expect(note.text).toContain('#4 bars @ 18 in. o.c. each way');
  });

  it('D-G: aging RFI, unacknowledged assignment, expiring permit, unapproved permit dependency', () => {
    expect(byId.R4.stage).toBe('Open');
    expect(days(byId.R4.dates.openedOn)).toBe(-9);
    expect(byId.I6.assignment).toMatchObject({ contractor: 'volt', acknowledged: false });
    expect(days(byId.P1.dates.expiresOn)).toBe(14);
    expect(byId.I6.permit).toBe('P3');
    expect(stageCategory(byId.P3.stage)).not.toBe('done');
  });

  it('A-201 plan text carries the egress issues Prompt 3 should find', () => {
    const a201 = PLAN_SHEETS.find((p) => p.sheetId === 'A-201')!.text;
    expect(a201).toMatch(/Corridor clear width: 40 in/);
    expect(a201).toMatch(/dead end 55 ft/);
  });
});

describe('seed helpers', () => {
  it('rewrites EXIF DateTimeOriginal in place without changing size', () => {
    for (const id of demoPhotoIds()) {
      const a = demoPhoto(id, new Date('2026-11-21T10:10:00Z'));
      const b = demoPhoto(id, new Date('2027-01-02T03:04:05Z'));
      expect(a.bytes.length).toBe(b.bytes.length);
      expect(a.bytes.includes(Buffer.from('2026:11:21 10:10:00'))).toBe(true);
      expect(b.exifDate).toBe('2027:01:02 03:04:05');
      expect(a.bytes[0]).toBe(0xff); // JPEG SOI
      expect(a.bytes[1]).toBe(0xd8);
    }
    expect(exifDate(new Date('2026-03-04T05:06:07Z'))).toHaveLength(19);
  });

  it('every photo referenced by a field note exists', () => {
    const ids = new Set(demoPhotoIds());
    for (const n of FIELD_NOTES) if (n.photo) expect(ids.has(n.photo)).toBe(true);
  });

  it('builds the entity property with parties and assignment', () => {
    const p = foremanProperty(byId.I6);
    expect(p).toMatchObject({ seedId: 'I6', kind: 'Inspection', contractor: 'Volt MEP', inspector: 'J. Ortiz', permitSeed: 'P3' });
    expect(p.assignment).toMatchObject({ contractor: 'Volt MEP', acknowledgedAt: null });
  });

  it('link payload puts the outward description on inwardIssue', () => {
    expect(linkPayload('Blocks', 'FMD-1', 'FMD-2')).toEqual({ type: { name: 'Blocks' }, inwardIssue: { key: 'FMD-1' }, outwardIssue: { key: 'FMD-2' } });
  });
});
