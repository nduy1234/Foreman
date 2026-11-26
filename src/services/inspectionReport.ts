import { z } from 'zod';
import { completeStructured, LlmProvider, MODELS } from '../lib/llm';
import { quoteFoundIn } from './planReview';

/**
 * Field evidence -> verified inspection report (pure: no Forge storage or Jira calls).
 *
 * 1. LLM extracts observations from field notes / voice transcripts (verbatim quotes only)
 *    and maps them to checklist items and permit conditions, citing plan text when it matters.
 * 2. Every quote is checked against its source; unsupported links are dropped.
 * 3. Deterministic checks are layered on top: prior inspections, permit validity, photo
 *    timestamps, and "no Verified line without evidence".
 * The report never recommends "Pass": only an inspector's sign-off can do that.
 */

export type LineStatus = 'verified' | 'needs_review' | 'conflict';

export interface EvidenceItem {
  id: string; // note-<commentId> | photo-<attachmentId>
  kind: 'note' | 'transcript' | 'photo';
  author: string | null;
  capturedAt: string | null; // ISO
  text?: string;
  filename?: string;
  exif?: { dateTimeOriginal?: string | null; lat?: number | null; lon?: number | null; make?: string | null; model?: string | null } | null;
}

export interface InspectionContext {
  issueKey: string;
  summary: string;
  stage: string | null;
  scheduledFor: string | null;
  inspectedOn: string | null;
  contractor: string | null;
  inspector: string | null;
  checklist: string[];
  permit: { key: string; summary: string; stage: string | null; permitNo: string | null; expiresOn: string | null; conditions: string[] } | null;
  priorInspections: { key: string; summary: string; stage: string | null }[];
  planSheets: { sheetId: string; title: string; text: string }[];
  planFindings: { ruleId: string; title: string; status: string; sheetId: string; evidenceQuote: string }[];
}

export interface EvidenceRef {
  type: 'observation' | 'photo' | 'plan' | 'permit' | 'prior_inspection' | 'finding';
  label: string;
  quote?: string;
  evidenceId?: string;
  capturedAt?: string | null;
  issueKey?: string;
  sheetId?: string;
}

export interface ReportLine {
  id: string;
  kind: 'checklist' | 'permit_condition' | 'permit' | 'prior_inspection' | 'photo';
  item: string;
  status: LineStatus;
  rationale: string;
  evidence: EvidenceRef[];
}

export interface Observation {
  id: string;
  evidenceId: string;
  quote: string;
  topic: string;
}

export interface VerifiedReport {
  issueKey: string;
  generatedAt: string;
  inspectionDate: string;
  observations: Observation[];
  lines: ReportLine[];
  counts: Record<LineStatus, number>;
  recommendation: 'ready_for_signoff' | 'needs_review' | 'conflicts_found';
  summary: string;
  dropped: { what: string; reason: string }[];
  usage: { input: number; output: number };
}

// ---------------- LLM contract ----------------

export const LlmReportSchema = z.object({
  observations: z
    .array(
      z.object({
        id: z.string().describe('O1, O2, ...'),
        evidenceId: z.string().describe('id of the note or transcript the quote comes from'),
        quote: z.string().describe('verbatim words copied from that note'),
        topic: z.string().describe('short topic, e.g. "hold-down at grid C/4"'),
      }),
    )
    .default([]),
  lines: z
    .array(
      z.object({
        item: z.string().describe('the checklist item or permit condition, copied exactly'),
        status: z.enum(['verified', 'needs_review', 'conflict']),
        observationIds: z.array(z.string()).default([]),
        photoIds: z.array(z.string()).default([]),
        planSheetId: z.string().nullable().default(null),
        planQuote: z.string().nullable().default(null).describe('verbatim plan text this item is checked against, if relevant'),
        rationale: z.string().describe('one sentence; include compared values'),
      }),
    )
    .default([]),
  summary: z.string().default(''),
});
export type LlmReport = z.infer<typeof LlmReportSchema>;

export const REPORT_SYSTEM_PROMPT = `You prepare construction inspection reports for a human inspector to sign.
You get: the inspection checklist, permit conditions, plan sheet text, field notes and voice-note transcripts, and photo metadata.

Do two things:
1. observations: extract each factual field observation from the notes/transcripts. "quote" must be copied word for word from
   that note (no paraphrase). Cite the note by its evidenceId.
2. lines: one line for EVERY checklist item and EVERY permit condition, using the item text exactly as given.
   - "verified": observations clearly show the item is complete and consistent with the plan.
   - "conflict": an observation contradicts the item, the plan text, or the permit condition (e.g. different bar size/spacing,
     element not installed). Put the contradicting plan words in planQuote, verbatim from the sheet text.
   - "needs_review": no observation covers it, or the evidence is partial or ambiguous.
   Link photos (photoIds) only when the photo filename or its timing clearly relates to the item.
   rationale: one sentence with the specific values compared.
summary: two sentences for the inspector. Never say the inspection passed; the inspector decides.`;

export function buildReportPrompt(ctx: InspectionContext, evidence: EvidenceItem[]): string {
  const notes = evidence.filter((e) => e.kind !== 'photo');
  const photos = evidence.filter((e) => e.kind === 'photo');
  const parts = [
    `INSPECTION ${ctx.issueKey}: ${ctx.summary}`,
    `Scheduled: ${ctx.scheduledFor ?? 'not scheduled'} | Contractor: ${ctx.contractor ?? 'n/a'} | Inspector: ${ctx.inspector ?? 'n/a'}`,
    '',
    'CHECKLIST ITEMS:',
    ...(ctx.checklist.length ? ctx.checklist.map((c) => `- ${c}`) : ['- (none listed)']),
    '',
    `PERMIT ${ctx.permit ? `${ctx.permit.permitNo ?? ''} (${ctx.permit.key}, ${ctx.permit.stage ?? 'unknown'})` : 'none linked'} CONDITIONS:`,
    ...(ctx.permit?.conditions.length ? ctx.permit.conditions.map((c) => `- ${c}`) : ['- (none)']),
    '',
    ...ctx.planSheets.flatMap((s) => [`PLAN SHEET ${s.sheetId} - ${s.title}`, '<<<', s.text, '>>>', '']),
    ...(ctx.planFindings.length
      ? ['OPEN PLAN-REVIEW FINDINGS:', ...ctx.planFindings.map((f) => `- ${f.ruleId} ${f.title} (${f.status}) on ${f.sheetId}`), '']
      : []),
    'FIELD NOTES AND TRANSCRIPTS:',
    ...(notes.length
      ? notes.map((n) => `[${n.id}] ${n.kind} by ${n.author ?? 'unknown'} at ${n.capturedAt ?? 'unknown time'}:\n${n.text}`)
      : ['(none)']),
    '',
    'PHOTOS (metadata only; image content is not available to you):',
    ...(photos.length
      ? photos.map((p) => `[${p.id}] ${p.filename} taken ${p.exif?.dateTimeOriginal ?? p.capturedAt ?? 'unknown time (no EXIF)'}`)
      : ['(none)']),
    '',
    'Call write_report.',
  ];
  return parts.join('\n');
}

// ---------------- validation + deterministic checks ----------------

const DAY = 86_400_000;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DAY);
}

const sameItem = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

export function assembleReport(
  ctx: InspectionContext,
  evidence: EvidenceItem[],
  llm: LlmReport,
  opts: { today: string; usage?: { input: number; output: number } },
): VerifiedReport {
  const dropped: { what: string; reason: string }[] = [];
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const inspectionDate = ctx.inspectedOn ?? ctx.scheduledFor ?? opts.today;

  // Observations must quote their source note verbatim.
  const observations: Observation[] = [];
  for (const o of llm.observations) {
    const src = byId.get(o.evidenceId);
    if (!src || src.kind === 'photo' || !src.text) {
      dropped.push({ what: `observation ${o.id}`, reason: 'unknown source note' });
      continue;
    }
    if (!quoteFoundIn(o.quote, src.text)) {
      dropped.push({ what: `observation ${o.id}`, reason: 'quote not found in source note' });
      continue;
    }
    observations.push({ id: o.id, evidenceId: o.evidenceId, quote: o.quote.trim(), topic: o.topic });
  }
  const obsById = new Map(observations.map((o) => [o.id, o]));

  const expected: { item: string; kind: ReportLine['kind'] }[] = [
    ...ctx.checklist.map((item) => ({ item, kind: 'checklist' as const })),
    ...(ctx.permit?.conditions ?? []).map((item) => ({ item, kind: 'permit_condition' as const })),
  ];

  const lines: ReportLine[] = [];
  let n = 0;
  for (const exp of expected) {
    const l = llm.lines.find((x) => sameItem(x.item, exp.item));
    const evidenceRefs: EvidenceRef[] = [];
    let status: LineStatus = 'needs_review';
    let rationale = 'No field observation covers this item yet.';
    if (l) {
      status = l.status;
      rationale = l.rationale;
      for (const oid of l.observationIds) {
        const o = obsById.get(oid);
        if (!o) continue;
        const src = byId.get(o.evidenceId)!;
        evidenceRefs.push({ type: 'observation', label: `${src.kind === 'transcript' ? 'Voice note' : 'Field note'} · ${src.author ?? 'unknown'}`, quote: o.quote, evidenceId: o.evidenceId, capturedAt: src.capturedAt });
      }
      for (const pid of l.photoIds) {
        const p = byId.get(pid);
        if (!p || p.kind !== 'photo') continue;
        evidenceRefs.push({ type: 'photo', label: p.filename ?? 'photo', evidenceId: p.id, capturedAt: p.exif?.dateTimeOriginal ?? p.capturedAt });
      }
      if (l.planQuote) {
        const sheet = ctx.planSheets.find((s) => s.sheetId === l.planSheetId) ?? ctx.planSheets.find((s) => quoteFoundIn(l.planQuote!, s.text));
        if (sheet && quoteFoundIn(l.planQuote, sheet.text)) {
          evidenceRefs.push({ type: 'plan', label: `Plan ${sheet.sheetId}`, quote: l.planQuote.trim(), sheetId: sheet.sheetId });
        } else {
          dropped.push({ what: `plan quote on "${exp.item}"`, reason: 'quote not found in plan text' });
        }
      }
      if (exp.kind === 'permit_condition' && ctx.permit) {
        evidenceRefs.push({ type: 'permit', label: `Permit ${ctx.permit.permitNo ?? ctx.permit.key} condition`, issueKey: ctx.permit.key, quote: exp.item });
      }
      // Guardrails: a Verified line needs real field evidence; a Conflict needs something to point at.
      const hasField = evidenceRefs.some((e) => e.type === 'observation' || e.type === 'photo');
      if (status === 'verified' && !evidenceRefs.some((e) => e.type === 'observation')) {
        status = 'needs_review';
        rationale = `${rationale} (Downgraded: no verified field observation supports this.)`;
      }
      if (status === 'conflict' && !hasField && !evidenceRefs.some((e) => e.type === 'plan')) {
        status = 'needs_review';
        rationale = `${rationale} (Downgraded: conflict not backed by quoted evidence.)`;
      }
    }
    lines.push({ id: `L${++n}`, kind: exp.kind, item: exp.item, status, rationale, evidence: evidenceRefs });
  }

  // Prior inspections in the required sequence must have passed.
  for (const p of ctx.priorInspections) {
    const passed = p.stage === 'Passed';
    lines.push({
      id: `L${++n}`,
      kind: 'prior_inspection',
      item: `Prerequisite inspection passed: ${p.summary}`,
      status: passed ? 'verified' : 'conflict',
      rationale: passed ? `${p.key} is Passed.` : `${p.key} is ${p.stage ?? 'not passed'}; this inspection cannot be signed off out of sequence.`,
      evidence: [{ type: 'prior_inspection', label: `${p.key} · ${p.stage ?? 'unknown'}`, issueKey: p.key }],
    });
  }

  // Permit must be approved and valid on the inspection date.
  if (ctx.permit) {
    const p = ctx.permit;
    let status: LineStatus = 'verified';
    let rationale = `Permit ${p.permitNo ?? p.key} is ${p.stage}.`;
    if (p.stage !== 'Approved') {
      status = 'conflict';
      rationale = `Permit ${p.permitNo ?? p.key} is ${p.stage ?? 'not approved'}; work under it cannot be inspected for approval.`;
    } else if (p.expiresOn && dayDiff(p.expiresOn, inspectionDate) < 0) {
      status = 'conflict';
      rationale = `Permit expired on ${p.expiresOn}, before the inspection date ${inspectionDate}.`;
    } else if (p.expiresOn && dayDiff(p.expiresOn, inspectionDate) <= 21) {
      status = 'needs_review';
      rationale = `Permit is approved but expires on ${p.expiresOn}, ${dayDiff(p.expiresOn, inspectionDate)} days after the inspection date. Request an extension.`;
    }
    lines.push({
      id: `L${++n}`,
      kind: 'permit',
      item: `Governing permit approved and valid (${p.permitNo ?? p.key})`,
      status,
      rationale,
      evidence: [{ type: 'permit', label: `${p.key} · ${p.stage ?? 'unknown'}${p.expiresOn ? ` · expires ${p.expiresOn}` : ''}`, issueKey: p.key }],
    });
  } else {
    lines.push({ id: `L${++n}`, kind: 'permit', item: 'Governing permit linked', status: 'needs_review', rationale: 'No permit is linked to this inspection.', evidence: [] });
  }

  // Photo timestamps must fall in a plausible window around the inspection.
  for (const ph of evidence.filter((e) => e.kind === 'photo')) {
    const taken = ph.exif?.dateTimeOriginal ?? null;
    if (!taken) {
      lines.push({ id: `L${++n}`, kind: 'photo', item: `Photo metadata: ${ph.filename}`, status: 'needs_review', rationale: 'No EXIF capture time; cannot confirm when the photo was taken.', evidence: [{ type: 'photo', label: ph.filename ?? 'photo', evidenceId: ph.id, capturedAt: null }] });
      continue;
    }
    const d = dayDiff(taken, inspectionDate);
    if (d > 1 || d < -45) {
      lines.push({
        id: `L${++n}`,
        kind: 'photo',
        item: `Photo timing: ${ph.filename}`,
        status: 'needs_review',
        rationale: `Photo taken ${taken.slice(0, 10)}, ${Math.abs(d)} days ${d > 0 ? 'after' : 'before'} the inspection date ${inspectionDate}.`,
        evidence: [{ type: 'photo', label: ph.filename ?? 'photo', evidenceId: ph.id, capturedAt: taken }],
      });
    }
  }

  const counts: Record<LineStatus, number> = { verified: 0, needs_review: 0, conflict: 0 };
  for (const l of lines) counts[l.status]++;
  const recommendation = counts.conflict ? 'conflicts_found' : counts.needs_review ? 'needs_review' : 'ready_for_signoff';
  const summary =
    (llm.summary?.trim() ? `${llm.summary.trim()} ` : '') +
    `${counts.verified} verified, ${counts.needs_review} need review, ${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}. Inspector sign-off required.`;

  return {
    issueKey: ctx.issueKey,
    generatedAt: new Date().toISOString(),
    inspectionDate,
    observations,
    lines,
    counts,
    recommendation,
    summary,
    dropped,
    usage: opts.usage ?? { input: 0, output: 0 },
  };
}

export async function generateReport(
  ctx: InspectionContext,
  evidence: EvidenceItem[],
  opts: { provider?: LlmProvider; today?: string } = {},
): Promise<VerifiedReport> {
  const res = await completeStructured({
    schema: LlmReportSchema,
    toolName: 'write_report',
    toolDescription: 'Write the structured, evidence-linked inspection report.',
    system: REPORT_SYSTEM_PROMPT,
    user: buildReportPrompt(ctx, evidence),
    model: MODELS.reasoning,
    maxTokens: 6000,
    provider: opts.provider,
  });
  return assembleReport(ctx, evidence, res.data, { today: opts.today ?? new Date().toISOString().slice(0, 10), usage: res.usage });
}

// ---------------- vision (optional, off by default) ----------------

/**
 * Pluggable photo describer. Forge LLMs are text-only, so the default is none: photos are used
 * for EXIF time/location and as corroboration. A BYOK vision provider can implement this, but
 * enabling it requires declaring egress in the manifest, which removes Runs on Atlassian
 * eligibility (see docs/PLAN.md D1).
 */
export interface VisionProvider {
  describe(photo: { filename: string; bytes: Uint8Array; mimeType: string }): Promise<string>;
}
