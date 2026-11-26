/**
 * Riverside Commons — the Foreman demo project.
 *
 * Pure data. All dates are day offsets from the seed day (day 0), so the planted problems
 * hold no matter when the demo is loaded or reset. `buildDataset(seedDate)` turns offsets into
 * ISO dates. Nothing here talks to Jira.
 *
 * Planted problems (asserted in test/dataset.test.ts):
 *  A. Framing inspection (I5) scheduled before its prerequisite Slab inspection (I4) passes.
 *  B. MEP permit (P3) stuck "In Review" for 12 days.
 *  C. Rebar inspection (I2) report contradicts plan sheet S-101 while Jira says Passed.
 *  D. RFI-4 open and unanswered for 9 days.
 *  E. Volt MEP has not acknowledged the MEP rough-in assignment (60 h).
 *  F. Foundation permit (P1) expires in 14 days.
 *  G. MEP rough-in (I6) depends on a permit (P3) that is not approved yet.
 */

export const DEMO_VERSION = 1;
export const DEMO_PROJECT_KEY = 'FMD';
export const DEMO_PROJECT_NAME = 'Riverside Commons (Foreman demo)';
export const DEMO_LABEL = 'foreman-demo';
export const seedLabel = (seedId: string) => `foreman-seed-${seedId.toLowerCase()}`;

export const ISSUE_TYPES = ['Permit', 'Inspection', 'RFI', 'Punch Item', 'Code Finding'] as const;
export type IssueTypeName = (typeof ISSUE_TYPES)[number];

export const ISSUE_TYPE_DESCRIPTIONS: Record<IssueTypeName, string> = {
  Permit: 'A building, MEP or fire permit tracked through jurisdiction review.',
  Inspection: 'A jurisdiction inspection in the required construction sequence.',
  RFI: 'Request for information from the field to the design team.',
  'Punch Item': 'A deficiency to correct before inspection or closeout.',
  'Code Finding': 'A code compliance finding from Foreman plan review.',
};

export const LINK_TYPES = {
  blocks: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  requiresPrior: { name: 'Requires Prior Inspection', outward: 'requires prior inspection', inward: 'is prerequisite for' },
  governedBy: { name: 'Governed By Permit', outward: 'is governed by permit', inward: 'governs' },
} as const;
export type LinkKind = keyof typeof LINK_TYPES;

/** Foreman stage. Jira status category is derived from it (see stageCategory). */
export type Stage =
  | 'Draft'
  | 'Submitted'
  | 'In Review'
  | 'Approved'
  | 'Expired'
  | 'Not Scheduled'
  | 'Scheduled'
  | 'Awaiting Sign-off'
  | 'Passed'
  | 'Failed'
  | 'Open'
  | 'Answered'
  | 'Closed'
  | 'Resolved';

export function stageCategory(stage: Stage): 'new' | 'indeterminate' | 'done' {
  if (['Approved', 'Passed', 'Answered', 'Closed', 'Resolved'].includes(stage)) return 'done';
  if (['Submitted', 'In Review', 'Scheduled', 'Awaiting Sign-off', 'Failed'].includes(stage)) return 'indeterminate';
  return 'new';
}

export const PROJECT_META = {
  name: 'Riverside Commons',
  address: '1400 Riverside Ave (fictional demo site)',
  occupancy: ['M', 'R-2'],
  constructionType: 'Type V-A over Type I-A podium',
  stories: 5,
  areaSqft: 62000,
  jurisdiction: 'City of Riverside (demo)',
  sprinklered: true,
  generalContractor: 'Northbeam Builders',
};

export interface Party {
  id: string;
  name: string;
  role: 'contractor' | 'inspector';
  trade?: string;
  org: string;
}

export const PARTIES: Party[] = [
  { id: 'atlas', name: 'Atlas Concrete', role: 'contractor', trade: 'Concrete', org: 'Atlas Concrete Inc.' },
  { id: 'keystone', name: 'Keystone Framing', role: 'contractor', trade: 'Framing', org: 'Keystone Framing LLC' },
  { id: 'volt', name: 'Volt MEP', role: 'contractor', trade: 'Electrical', org: 'Volt MEP Contractors' },
  { id: 'ortiz', name: 'J. Ortiz', role: 'inspector', org: 'City of Riverside - Building' },
  { id: 'chen', name: 'M. Chen', role: 'inspector', org: 'City of Riverside - Fire Prevention' },
];

export interface SeedIssue {
  seedId: string;
  type: IssueTypeName;
  summary: string;
  description: string;
  stage: Stage;
  trade: string;
  level: string;
  permitNo?: string;
  jurisdiction?: string;
  /** Seed id of the governing permit (inspections). */
  permit?: string;
  contractor?: string;
  inspector?: string;
  /** Day offsets from seed day. */
  submittedDay?: number;
  approvedDay?: number;
  expiresDay?: number;
  scheduledDay?: number;
  inspectedDay?: number;
  openedDay?: number;
  assignment?: { contractor: string; assignedHoursAgo: number; acknowledged: boolean };
  checklist?: string[];
  /** Plan sheets this item relates to. */
  sheets?: string[];
}

const J = PROJECT_META.jurisdiction;

export const ISSUES: SeedIssue[] = [
  // ---- Permits ----
  {
    seedId: 'P1', type: 'Permit', summary: 'P-1 Foundation permit',
    description: 'Foundation and below-grade work: footings, grade beams, underground utilities stub-outs.',
    stage: 'Approved', trade: 'Concrete', level: 'Foundation', permitNo: 'BLD-2026-0412-F', jurisdiction: J,
    submittedDay: -60, approvedDay: -45, expiresDay: 14, sheets: ['S-101'],
  },
  {
    seedId: 'P2', type: 'Permit', summary: 'P-2 Building permit (shell and core)',
    description: 'Podium slab, Type V-A wood framing Levels 2-5, building envelope, egress and life safety.',
    stage: 'Approved', trade: 'General', level: 'All levels', permitNo: 'BLD-2026-0413', jurisdiction: J,
    submittedDay: -55, approvedDay: -30, expiresDay: 180, sheets: ['A-201', 'S-101'],
  },
  {
    seedId: 'P3', type: 'Permit', summary: 'P-3 MEP permit (mechanical, electrical, plumbing)',
    description: 'Mechanical, electrical and plumbing systems for Levels 1-5. Plan check comments pending from city.',
    stage: 'In Review', trade: 'Mechanical', level: 'All levels', permitNo: 'MEP-2026-0977', jurisdiction: J,
    submittedDay: -12,
  },
  {
    seedId: 'P4', type: 'Permit', summary: 'P-4 Fire sprinkler permit (NFPA 13)',
    description: 'NFPA 13 sprinkler system, standpipes and fire alarm interface.',
    stage: 'Submitted', trade: 'Fire Protection', level: 'All levels', permitNo: 'FSP-2026-0201', jurisdiction: J,
    submittedDay: -3, sheets: ['FP-101'],
  },

  // ---- Inspections (required sequence) ----
  {
    seedId: 'I1', type: 'Inspection', summary: 'Footing inspection - Grid A-D / 1-6',
    description: 'Footing excavation, dimensions and bearing soil before placing reinforcement.',
    stage: 'Passed', trade: 'Concrete', level: 'Foundation', permit: 'P1', contractor: 'atlas', inspector: 'ortiz',
    scheduledDay: -40, inspectedDay: -40, sheets: ['S-101'],
    checklist: ['Footing dimensions per S-101', 'Bearing on native soil per geotech letter', 'Excavation free of water and loose material'],
  },
  {
    seedId: 'I2', type: 'Inspection', summary: 'Foundation reinforcement (rebar) inspection',
    description: 'Bottom mat and dowels before pour.',
    stage: 'Passed', trade: 'Concrete', level: 'Foundation', permit: 'P1', contractor: 'atlas', inspector: 'ortiz',
    scheduledDay: -35, inspectedDay: -35, sheets: ['S-101'],
    checklist: ['Bar size and spacing per S-101', 'Clear cover 3 in. bottom', 'Dowels and laps per S-101', 'Chairs and ties secure'],
  },
  {
    seedId: 'I3', type: 'Inspection', summary: 'Underground plumbing inspection',
    description: 'Under-slab sanitary and water lines, test and sleeves.',
    stage: 'Passed', trade: 'Plumbing', level: 'Level 1', permit: 'P2', contractor: 'volt', inspector: 'ortiz',
    scheduledDay: -20, inspectedDay: -20,
    checklist: ['Water test on DWV holds 15 min', 'Sleeves at slab penetrations', 'Cleanouts accessible'],
  },
  {
    seedId: 'I4', type: 'Inspection', summary: 'Slab on grade pre-pour inspection - Level 1',
    description: 'Vapor barrier, under-slab insulation, slab reinforcement and embeds before pour.',
    stage: 'Scheduled', trade: 'Concrete', level: 'Level 1', permit: 'P2', contractor: 'atlas', inspector: 'ortiz',
    scheduledDay: 5, sheets: ['S-101'],
    checklist: ['Vapor barrier lapped and taped', 'Perimeter insulation installed', 'Slab reinforcement per S-101', 'Embeds and sleeves set'],
  },
  {
    seedId: 'I5', type: 'Inspection', summary: 'Framing inspection - Levels 2-3',
    description: 'Wood framing, shear walls, hold-downs and rated corridor wall framing.',
    stage: 'Scheduled', trade: 'Framing', level: 'Level 2', permit: 'P2', contractor: 'keystone', inspector: 'ortiz',
    scheduledDay: 3, sheets: ['A-201'],
    checklist: ['Shear wall nailing per schedule', 'Hold-downs installed at grid C/4', 'Rated corridor walls framed per A-201', 'Fireblocking at concealed spaces'],
  },
  {
    seedId: 'I6', type: 'Inspection', summary: 'MEP rough-in inspection - Level 2',
    description: 'Electrical, plumbing and mechanical rough-in before cover.',
    stage: 'Scheduled', trade: 'Electrical', level: 'Level 2', permit: 'P3', contractor: 'volt', inspector: 'ortiz',
    scheduledDay: 10, assignment: { contractor: 'volt', assignedHoursAgo: 60, acknowledged: false },
    checklist: ['Boxes set and secured', 'Home runs pulled and labelled', 'Penetrations of rated walls firestopped', 'Plumbing rough-in pressure test'],
  },
  {
    seedId: 'I7', type: 'Inspection', summary: 'Fire sprinkler rough-in and firestopping inspection',
    description: 'Sprinkler piping hydro test and firestopping of rated assemblies.',
    stage: 'Not Scheduled', trade: 'Fire Protection', level: 'Levels 1-5', permit: 'P4', contractor: 'volt', inspector: 'chen',
    sheets: ['FP-101', 'A-201'],
    checklist: ['Hydrostatic test 200 psi for 2 h', 'Head spacing per FP-101', 'Firestopping systems listed and installed'],
  },
  {
    seedId: 'I8', type: 'Inspection', summary: 'Final building inspection',
    description: 'Final inspection for certificate of occupancy.',
    stage: 'Not Scheduled', trade: 'General', level: 'All levels', permit: 'P2', inspector: 'ortiz',
    checklist: ['All prior inspections passed', 'Egress paths clear and signed', 'Accessibility features complete', 'Fire department sign-off'],
  },

  // ---- RFIs ----
  {
    seedId: 'R1', type: 'RFI', summary: 'RFI-1 Footing step detail at grid A',
    description: 'S-101 detail 4 does not show step dimensions where footing steps at grid A/3.',
    stage: 'Closed', trade: 'Concrete', level: 'Foundation', contractor: 'atlas', openedDay: -48, sheets: ['S-101'],
  },
  {
    seedId: 'R2', type: 'RFI', summary: 'RFI-2 Shear wall hold-down at grid C/4',
    description: 'Hold-down HDU8 at grid C/4 conflicts with plumbing chase. Request alternate location or product.',
    stage: 'Open', trade: 'Framing', level: 'Level 2', contractor: 'keystone', openedDay: -4, sheets: ['A-201'],
  },
  {
    seedId: 'R3', type: 'RFI', summary: 'RFI-3 Corridor wall rating at Level 2 east',
    description: 'Confirm the Level 2 east corridor wall assembly; A-201 note 7 references UL U419 but wall type tag shows W2.',
    stage: 'Open', trade: 'Framing', level: 'Level 2', contractor: 'keystone', openedDay: -2, sheets: ['A-201'],
  },
  {
    seedId: 'R4', type: 'RFI', summary: 'RFI-4 Sprinkler main routing conflicts with supply duct at Level 1 retail',
    description: '4 in. sprinkler main and 24x14 supply duct occupy the same space above retail bay 3. Need coordinated routing.',
    stage: 'Open', trade: 'Fire Protection', level: 'Level 1', contractor: 'volt', openedDay: -9, sheets: ['FP-101'],
  },
  {
    seedId: 'R5', type: 'RFI', summary: 'RFI-5 Storefront glazing specification',
    description: 'Confirm tempered vs laminated glazing at retail storefront adjacent to walking surface.',
    stage: 'Answered', trade: 'Finishes', level: 'Level 1', openedDay: -15,
  },

  // ---- Punch items ----
  {
    seedId: 'PI1', type: 'Punch Item', summary: 'Patch spalled concrete at footing edge grid B/2',
    description: 'Minor spall at form tie, patch with approved repair mortar.',
    stage: 'Resolved', trade: 'Concrete', level: 'Foundation', contractor: 'atlas',
  },
  {
    seedId: 'PI2', type: 'Punch Item', summary: 'Re-tie displaced rebar chairs at slab edge',
    description: 'Chairs displaced along east slab edge; restore 3 in. clearance before slab pre-pour inspection.',
    stage: 'Open', trade: 'Concrete', level: 'Level 1', contractor: 'atlas',
  },
  {
    seedId: 'PI3', type: 'Punch Item', summary: 'Missing firestopping at Level 2 electrical penetrations',
    description: 'Rated corridor wall penetrations at grid C-D open; install listed firestop system.',
    stage: 'Open', trade: 'Electrical', level: 'Level 2', contractor: 'volt',
  },
  {
    seedId: 'PI4', type: 'Punch Item', summary: 'Replace damaged sill plate at grid D/6',
    description: 'Sill plate split at anchor bolt; replace with pressure-treated plate.',
    stage: 'Open', trade: 'Framing', level: 'Level 2', contractor: 'keystone',
  },
  {
    seedId: 'PI5', type: 'Punch Item', summary: 'Clear debris from stair 2 egress path',
    description: 'Material staging blocks stair 2 landing; keep egress path clear.',
    stage: 'Open', trade: 'General', level: 'Level 1',
  },

  // ---- Code findings (from an earlier review) ----
  {
    seedId: 'CF1', type: 'Code Finding', summary: 'Egress: dead-end corridor at Level 2 exceeds limit (A-201)',
    description: 'A-201 shows a 55 ft dead-end corridor at the Level 2 west wing; limit is 50 ft for sprinklered R-2 (IBC 2021 Section 1020.5, exception 2).',
    stage: 'Open', trade: 'General', level: 'Level 2', sheets: ['A-201'],
  },
  {
    seedId: 'CF2', type: 'Code Finding', summary: 'Accessibility: retail entry route slope',
    description: 'Accessible route at retail entry shown at 1:16 running slope; revised to 1:20 in addendum 2.',
    stage: 'Resolved', trade: 'General', level: 'Level 1',
  },
  {
    seedId: 'CF3', type: 'Code Finding', summary: 'Fire separation: firestopping schedule missing',
    description: 'No listed firestop systems are scheduled for penetrations of 1-hour corridor walls (IBC 2021 Section 714).',
    stage: 'Open', trade: 'Fire Protection', level: 'Levels 1-5', sheets: ['A-201', 'FP-101'],
  },
];

export interface SeedLink {
  kind: LinkKind;
  /** Outward issue (e.g. I5 "requires prior inspection" I4). */
  from: string;
  to: string;
}

const SEQUENCE = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'];

export const LINKS: SeedLink[] = [
  ...SEQUENCE.slice(1).map((id, i) => ({ kind: 'requiresPrior' as const, from: id, to: SEQUENCE[i] })),
  ...ISSUES.filter((i) => i.type === 'Inspection' && i.permit).map((i) => ({ kind: 'governedBy' as const, from: i.seedId, to: i.permit! })),
  { kind: 'blocks', from: 'R2', to: 'I5' },
  { kind: 'blocks', from: 'R4', to: 'P4' },
  { kind: 'blocks', from: 'PI2', to: 'I4' },
  { kind: 'blocks', from: 'PI3', to: 'I7' },
  { kind: 'blocks', from: 'CF1', to: 'I8' },
];

export interface PlanSheet {
  sheetId: string;
  title: string;
  discipline: 'Architectural' | 'Structural' | 'Fire Protection';
  text: string;
}

/** Sample plan-set text (sheet notes). Deliberately contains code problems for Prompt 3. */
export const PLAN_SHEETS: PlanSheet[] = [
  {
    sheetId: 'A-201',
    title: 'Level 2 Floor Plan and Life Safety Notes',
    discipline: 'Architectural',
    text: [
      'SHEET A-201 - LEVEL 2 FLOOR PLAN - RIVERSIDE COMMONS',
      'OCCUPANCY: R-2 (Levels 2-5). CONSTRUCTION TYPE: V-A. BUILDING FULLY SPRINKLERED PER NFPA 13.',
      'GENERAL NOTES:',
      '1. Level 2 occupant load: 112 occupants (residential 200 gross sf per occupant).',
      '2. Exits: two exit stairs, Stair 1 at grid A/1 and Stair 2 at grid A/3.',
      '3. Exit separation: Stair 1 and Stair 2 entrances are 38 ft apart measured in a straight line. Overall diagonal of floor plate is 180 ft.',
      '4. Corridor clear width: 40 in. minimum at all residential corridors.',
      '5. West wing corridor terminates in a dead end 55 ft long beyond the last exit access point.',
      '6. Common path of egress travel from unit 214: 60 ft.',
      '7. Corridor walls: 1-hour fire-resistance-rated, UL U419, one layer 5/8 in. Type X gypsum board each side, full height to underside of floor deck.',
      '8. Corridor doors: 20-minute rated, self-closing, positive latching, 36 in. clear width.',
      '9. Penetrations of rated corridor walls: see FP-101 (firestop systems to be submitted).',
      '10. Accessible units: 2 Type A units (215, 216) and Type B units elsewhere on this level.',
      '11. Exit signs at each exit and at corridor turns; emergency lighting at 1 fc average along egress path.',
      '12. Door hardware: lever handles mounted 34-48 in. above finished floor.',
      '13. Unit entry door maneuvering clearance on pull side: 18 in. beyond latch side.',
      '14. Max travel distance to an exit: 190 ft (sprinklered).',
    ].join('\n'),
  },
  {
    sheetId: 'S-101',
    title: 'Foundation Plan and Structural Notes',
    discipline: 'Structural',
    text: [
      'SHEET S-101 - FOUNDATION PLAN - RIVERSIDE COMMONS',
      'DESIGN: IBC 2021, ACI 318-19. f\'c = 4,000 psi at 28 days for footings and slab on grade.',
      'FOOTINGS: Continuous footings 24 in. wide x 12 in. deep. Bottom of footing on undisturbed native soil per geotechnical report GR-2026-14.',
      'REINFORCEMENT: Footing bottom mat #5 bars @ 12 in. o.c. each way. Clear cover 3 in. to earth.',
      'DOWELS: #5 @ 16 in. o.c. into podium walls, lap 30 in.',
      'SLAB ON GRADE: 5 in. slab with #4 @ 16 in. o.c. each way at mid-depth over 15 mil vapor retarder, seams lapped 6 in. and taped.',
      'PERIMETER INSULATION: R-10 rigid insulation 24 in. deep at slab edge.',
      'SPECIAL INSPECTION: Reinforcement placement requires special inspection prior to concrete placement.',
    ].join('\n'),
  },
  {
    sheetId: 'FP-101',
    title: 'Fire Protection Plan Level 1-2',
    discipline: 'Fire Protection',
    text: [
      'SHEET FP-101 - FIRE PROTECTION - RIVERSIDE COMMONS',
      'SYSTEM: NFPA 13 wet-pipe sprinkler system throughout. Light hazard residential, ordinary hazard group 1 retail.',
      'RETAIL (LEVEL 1): Max sprinkler spacing 130 sf per head.',
      'RESIDENTIAL (LEVELS 2-5): Residential sprinklers, max coverage per listing.',
      'HYDROSTATIC TEST: 200 psi for 2 hours.',
      'FIRESTOPPING: Penetrations of rated assemblies to use listed systems - schedule TO BE SUBMITTED.',
      'MAIN: 4 in. main routed above retail bay 3 at elevation 13 ft 6 in. (coordinate with mechanical).',
    ].join('\n'),
  },
];

export interface FieldNote {
  issue: string;
  kind: 'note' | 'transcript';
  author: string;
  /** Day offset; time fixed at 10:30 local. */
  day: number;
  text: string;
  photo?: string;
}

export const FIELD_NOTES: FieldNote[] = [
  {
    issue: 'I1', kind: 'note', author: 'J. Ortiz (City inspector)', day: -40, photo: 'footing',
    text: 'Footing dimensions verified 24 in. x 12 in. at grids A-D/1-6. Bottom of footing on native soil, consistent with geotech letter. Excavation clean and dry. Approved to place reinforcement.',
  },
  {
    issue: 'I2', kind: 'note', author: 'J. Ortiz (City inspector)', day: -35, photo: 'rebar',
    text: 'Bottom mat observed #4 bars @ 18 in. o.c. each way at grid B-C/2-3. Clear cover approximately 3 in. on chairs. Dowels in place. Approved to pour.',
  },
  {
    issue: 'I4', kind: 'note', author: 'R. Diaz (Northbeam superintendent)', day: -1, photo: 'slab',
    text: 'Vapor retarder installed, seams lapped and taped. Plumbing stubs sleeved. Perimeter insulation NOT yet installed at east slab edge. Rebar chairs displaced along east edge (see punch item).',
  },
  {
    issue: 'I5', kind: 'note', author: 'R. Diaz (Northbeam superintendent)', day: -1, photo: 'framing',
    text: 'Level 2 corridor walls framed. Unit side gypsum hung; corridor side gypsum not hung at grid C-D. Hold-down at grid C/4 not installed pending RFI-2. Shear wall nailing complete on east wing.',
  },
  {
    issue: 'I6', kind: 'transcript', author: 'Voice note - R. Diaz', day: 0, photo: 'mep',
    text: 'Walked level two with the Volt foreman. Boxes are set and home runs pulled on the east wing, west wing not started. The conduit through the rated corridor wall at grid C is not firestopped yet. Volt has not confirmed the rough-in inspection date.',
  },
];

// ---------- Builder ----------

export interface BuiltIssue extends SeedIssue {
  labels: string[];
  dates: {
    submittedOn?: string;
    approvedOn?: string;
    expiresOn?: string;
    scheduledFor?: string;
    inspectedOn?: string;
    openedOn?: string;
  };
  assignmentAt?: string;
}

const DAY = 24 * 60 * 60 * 1000;

export function isoDay(seedDate: Date, offset: number | undefined): string | undefined {
  if (offset === undefined) return undefined;
  const d = new Date(Date.UTC(seedDate.getUTCFullYear(), seedDate.getUTCMonth(), seedDate.getUTCDate()) + offset * DAY);
  return d.toISOString().slice(0, 10);
}

export function buildIssues(seedDate: Date): BuiltIssue[] {
  return ISSUES.map((i) => ({
    ...i,
    labels: [DEMO_LABEL, seedLabel(i.seedId)],
    dates: {
      submittedOn: isoDay(seedDate, i.submittedDay),
      approvedOn: isoDay(seedDate, i.approvedDay),
      expiresOn: isoDay(seedDate, i.expiresDay),
      scheduledFor: isoDay(seedDate, i.scheduledDay),
      inspectedOn: isoDay(seedDate, i.inspectedDay),
      openedOn: isoDay(seedDate, i.openedDay),
    },
    assignmentAt: i.assignment ? new Date(seedDate.getTime() - i.assignment.assignedHoursAgo * 3600_000).toISOString() : undefined,
  }));
}

/** Timestamp for a field note: seed day + offset, 10:30 UTC. */
export function noteTimestamp(seedDate: Date, day: number): Date {
  const base = Date.UTC(seedDate.getUTCFullYear(), seedDate.getUTCMonth(), seedDate.getUTCDate(), 10, 30);
  return new Date(base + day * DAY);
}

export const partyName = (id: string | undefined) => PARTIES.find((p) => p.id === id)?.name;
