import { z } from 'zod';
import { completeStructured, LlmProvider, MODELS } from '../lib/llm';
import { LlmFinding, ProjectMeta, Rule } from '../lib/schemas';

/**
 * Plan-vs-code review engine (pure: no Forge storage or Jira calls here).
 *
 *   selectRules  -> which rules apply to this project + sheet discipline
 *   evaluate     -> LLM judges each rule against the sheet text (batched, structured output)
 *   validate     -> keep only findings whose evidence quote really appears in the sheet text
 */

export interface PlanSheetInput {
  sheetId: string;
  title: string;
  discipline?: string | null;
  text: string;
}

export interface ReviewFinding {
  ruleId: string;
  category: Rule['category'];
  title: string;
  citation: string;
  severity: Rule['severity'];
  status: 'pass' | 'fail' | 'needs_review';
  evidenceQuote: string;
  confidence: number;
  suggestedFix: string;
  reasoning: string;
}

export interface RejectedFinding {
  ruleId: string;
  status: string;
  reason: 'no_evidence' | 'quote_not_in_source' | 'not_applicable' | 'unknown_rule' | 'missing';
  quote?: string;
}

export interface ReviewResult {
  sheetId: string;
  rulesChecked: number;
  findings: ReviewFinding[];
  rejected: RejectedFinding[];
  usage: { input: number; output: number };
  model: string;
}

// ---------- rule selection ----------

export function ruleApplies(rule: Rule, meta: ProjectMeta, discipline?: string | null): boolean {
  const w = rule.appliesWhen;
  if (discipline && rule.disciplines.length && !rule.disciplines.includes(discipline as never)) return false;
  if (w.occupancy?.length && !w.occupancy.some((o) => meta.occupancy.includes(o))) return false;
  if (w.minStories !== undefined && meta.stories < w.minStories) return false;
  if (w.maxStories !== undefined && meta.stories > w.maxStories) return false;
  if (w.sprinklered !== undefined && meta.sprinklered !== w.sprinklered) return false;
  if (w.constructionTypes?.length) {
    const ct = meta.constructionType.toLowerCase();
    if (!w.constructionTypes.some((t) => ct.includes(t.toLowerCase()))) return false;
  }
  return true;
}

export function selectRules(rules: Rule[], meta: ProjectMeta, discipline?: string | null): Rule[] {
  return rules.filter((r) => ruleApplies(r, meta, discipline));
}

// ---------- evidence validation ----------

/** Normalize for quote matching: case, whitespace, smart quotes, dashes, trailing punctuation. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the quote appears verbatim (after normalization) in the source.
 * Quotes elided with "..." must have every segment present, in order.
 */
export function quoteFoundIn(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote).replace(/^["']|["']$/g, '').replace(/[.;,:]+$/, '');
  if (q.length < 8) return false;
  const src = normalizeForMatch(source);
  const segments = q
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  let from = 0;
  for (const seg of segments) {
    const at = src.indexOf(seg, from);
    if (at < 0) return false;
    from = at + seg.length;
  }
  return segments.length > 0;
}

export function validateFindings(raw: LlmFinding[], rules: Rule[], sourceText: string): { findings: ReviewFinding[]; rejected: RejectedFinding[] } {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const findings: ReviewFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const seen = new Set<string>();

  for (const f of raw) {
    const rule = byId.get(f.ruleId);
    if (!rule) {
      rejected.push({ ruleId: f.ruleId, status: f.status, reason: 'unknown_rule' });
      continue;
    }
    if (seen.has(f.ruleId)) continue; // first answer per rule wins
    seen.add(f.ruleId);
    if (f.status === 'not_applicable') {
      rejected.push({ ruleId: f.ruleId, status: f.status, reason: 'not_applicable' });
      continue;
    }
    const quote = f.evidenceQuote?.trim() ?? '';
    if (!quote) {
      rejected.push({ ruleId: f.ruleId, status: f.status, reason: 'no_evidence' });
      continue;
    }
    if (!quoteFoundIn(quote, sourceText)) {
      rejected.push({ ruleId: f.ruleId, status: f.status, reason: 'quote_not_in_source', quote });
      continue;
    }
    findings.push({
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      citation: rule.citation,
      severity: rule.severity,
      status: f.status,
      evidenceQuote: quote,
      confidence: Math.round(f.confidence * 100) / 100,
      suggestedFix: f.status === 'pass' ? '' : f.suggestedFix,
      reasoning: f.reasoning,
    });
  }
  for (const r of rules) {
    if (!seen.has(r.id)) rejected.push({ ruleId: r.id, status: 'missing', reason: 'missing' });
  }
  return { findings, rejected };
}

// ---------- LLM evaluation ----------

export const BatchSchema = z.object({
  findings: z.array(LlmFinding).describe('Exactly one entry per rule, in the order given.'),
});

export const SYSTEM_PROMPT = `You are a senior building-code plan reviewer helping a construction project team.
You check one plan sheet against a list of code rules. Each rule has an id, a citation and a pass/fail test.

For EVERY rule return one entry:
- status "fail": the sheet text shows something that violates the test.
- status "pass": the sheet text shows something that satisfies the test.
- status "needs_review": the sheet addresses the topic but the text is ambiguous or incomplete.
- status "not_applicable": the sheet does not address the rule at all.
- evidenceQuote: copy the exact words from the sheet text that support your status (one sentence or line, verbatim,
  no paraphrase, no added words). Use an empty string only for not_applicable.
- confidence: 0 to 1.
- suggestedFix: for fail or needs_review, one concrete sentence telling the designer what to change or clarify.
- reasoning: one short sentence with the numbers you compared (for example "40 in. < 44 in. required for 112 occupants").

Use only the sheet text and project facts given. Do not invent dimensions. Do the arithmetic explicitly.
This is review guidance for the project team, not a legal determination.`;

export function buildUserPrompt(sheet: PlanSheetInput, meta: ProjectMeta, rules: Rule[]): string {
  const facts = [
    `Project: ${meta.name}`,
    `Occupancy: ${meta.occupancy.join(', ')}`,
    `Construction type: ${meta.constructionType}`,
    `Stories: ${meta.stories}`,
    `Area: ${meta.areaSqft} sq ft`,
    `Jurisdiction: ${meta.jurisdiction}`,
    `Sprinklered: ${meta.sprinklered ? 'yes, NFPA 13 throughout' : 'no'}`,
  ].join('\n');
  const ruleText = rules
    .map((r) => `- id: ${r.id}\n  citation: ${r.citation}\n  title: ${r.title}\n  test: ${r.test}`)
    .join('\n');
  return `PROJECT FACTS\n${facts}\n\nSHEET ${sheet.sheetId} - ${sheet.title}\n<<<SHEET TEXT\n${sheet.text}\nSHEET TEXT>>>\n\nRULES (${rules.length})\n${ruleText}\n\nCall report_findings with one entry per rule.`;
}

export interface EvaluateOptions {
  provider?: LlmProvider;
  model?: string;
  batchSize?: number;
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export async function evaluateSheet(sheet: PlanSheetInput, meta: ProjectMeta, rules: Rule[], opts: EvaluateOptions = {}): Promise<ReviewResult> {
  const batchSize = opts.batchSize ?? 6;
  const model = opts.model ?? MODELS.reasoning;
  const batches: Rule[][] = [];
  for (let i = 0; i < rules.length; i += batchSize) batches.push(rules.slice(i, i + batchSize));

  const raw: LlmFinding[] = [];
  const usage = { input: 0, output: 0 };
  let done = 0;
  // Two batches at a time keeps us well under the Forge LLM 100 req/min limit.
  for (let i = 0; i < batches.length; i += 2) {
    const results = await Promise.all(
      batches.slice(i, i + 2).map((batch) =>
        completeStructured({
          schema: BatchSchema,
          toolName: 'report_findings',
          toolDescription: 'Report one code-review finding per rule for this plan sheet.',
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(sheet, meta, batch),
          model,
          maxTokens: 4096,
          provider: opts.provider,
        }),
      ),
    );
    for (const r of results) {
      raw.push(...r.data.findings);
      usage.input += r.usage.input;
      usage.output += r.usage.output;
    }
    done += Math.min(2, batches.length - i);
    await opts.onProgress?.(done, batches.length);
  }

  const { findings, rejected } = validateFindings(raw, rules, sheet.text);
  const order = { fail: 0, needs_review: 1, pass: 2 } as const;
  const sev = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  findings.sort((a, b) => order[a.status] - order[b.status] || sev[a.severity] - sev[b.severity]);
  return { sheetId: sheet.sheetId, rulesChecked: rules.length, findings, rejected, usage, model };
}
