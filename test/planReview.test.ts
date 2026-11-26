import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../src/lib/llm';
import { ProjectMeta } from '../src/lib/schemas';
import { RULES } from '../src/rules';
import { PLAN_SHEETS, PROJECT_META } from '../src/seed/dataset';
import {
  buildUserPrompt,
  evaluateSheet,
  normalizeForMatch,
  quoteFoundIn,
  selectRules,
  validateFindings,
} from '../src/services/planReview';

const meta = ProjectMeta.parse(PROJECT_META);
const A201 = PLAN_SHEETS.find((s) => s.sheetId === 'A-201')!;
const S101 = PLAN_SHEETS.find((s) => s.sheetId === 'S-101')!;
const FP101 = PLAN_SHEETS.find((s) => s.sheetId === 'FP-101')!;

describe('rule pack', () => {
  it('has 30-40 valid rules with unique ids across all five categories', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(30);
    expect(RULES.length).toBeLessThanOrEqual(40);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    const cats = new Set(RULES.map((r) => r.category));
    expect([...cats].sort()).toEqual(['accessibility', 'egress', 'fire-separation', 'permit-prerequisite', 'structural']);
  });

  it('every rule has a citation, applicability conditions and a pass/fail test', () => {
    for (const r of RULES) {
      expect(r.citation).toMatch(/IBC 2021|ADA Standards|ACI 318-19/);
      expect(r.appliesWhen).toBeTypeOf('object');
      expect(r.test).toMatch(/Pass if/);
    }
  });
});

describe('rule selection', () => {
  it('picks architectural rules for A-201 and structural rules for S-101', () => {
    const arch = selectRules(RULES, meta, 'Architectural');
    const struct = selectRules(RULES, meta, 'Structural');
    expect(arch.map((r) => r.id)).toEqual(expect.arrayContaining(['EGR-1020.3', 'EGR-1020.5', 'EGR-1007.1.1', 'FIR-1020.2']));
    expect(arch.some((r) => r.category === 'structural')).toBe(false);
    expect(struct.every((r) => r.disciplines.includes('Structural'))).toBe(true);
    expect(struct.map((r) => r.id)).toContain('STR-ACI-20.5.1.3');
  });

  it('applies occupancy, story and construction-type conditions', () => {
    const smallOffice = ProjectMeta.parse({ ...meta, occupancy: ['B'], stories: 1, constructionType: 'Type V-B' });
    const ids = selectRules(RULES, smallOffice).map((r) => r.id);
    expect(ids).not.toContain('EGR-1017.2'); // R-2 only
    expect(ids).not.toContain('EGR-1006.3'); // minStories 2
    expect(ids).not.toContain('FIR-510.2'); // podium only
    expect(selectRules(RULES, meta).map((r) => r.id)).toContain('FIR-510.2');
  });
});

describe('evidence validation', () => {
  it('matches verbatim quotes despite whitespace, case and smart quotes', () => {
    expect(quoteFoundIn('Corridor clear width: 40 in. minimum at all residential corridors.', A201.text)).toBe(true);
    expect(quoteFoundIn('  corridor CLEAR width:   40 in. minimum ', A201.text)).toBe(true);
    expect(quoteFoundIn('Stair 1 and Stair 2 entrances are 38 ft apart ... diagonal of floor plate is 180 ft', A201.text)).toBe(true);
    expect(normalizeForMatch('f’c – 4,000')).toBe("f'c - 4,000");
  });

  it('rejects paraphrased, fabricated, out-of-order and too-short quotes', () => {
    expect(quoteFoundIn('Corridors are 40 inches wide', A201.text)).toBe(false);
    expect(quoteFoundIn('Corridor clear width: 48 in. minimum', A201.text)).toBe(false);
    expect(quoteFoundIn('diagonal of floor plate is 180 ft ... Stair 1 and Stair 2', A201.text)).toBe(false);
    expect(quoteFoundIn('40 in.', A201.text)).toBe(false);
  });

  it('drops findings with no evidence quote and keeps a rejection record', () => {
    const rules = RULES.filter((r) => ['EGR-1020.3', 'EGR-1020.5', 'FIR-1023.2', 'ADA-405.2'].includes(r.id));
    const { findings, rejected } = validateFindings(
      [
        { ruleId: 'EGR-1020.3', status: 'fail', evidenceQuote: 'Corridor clear width: 40 in. minimum', confidence: 0.9, suggestedFix: 'Widen to 44 in.', reasoning: '' },
        { ruleId: 'EGR-1020.5', status: 'fail', evidenceQuote: '', confidence: 0.8, suggestedFix: '', reasoning: '' },
        { ruleId: 'FIR-1023.2', status: 'needs_review', evidenceQuote: 'Stairs are 2-hour enclosures', confidence: 0.5, suggestedFix: '', reasoning: '' },
        { ruleId: 'ADA-405.2', status: 'not_applicable', evidenceQuote: '', confidence: 0.9, suggestedFix: '', reasoning: '' },
        { ruleId: 'XYZ-1', status: 'fail', evidenceQuote: 'Corridor clear width: 40 in.', confidence: 1, suggestedFix: '', reasoning: '' },
      ],
      rules,
      A201.text,
    );
    expect(findings.map((f) => f.ruleId)).toEqual(['EGR-1020.3']);
    expect(findings[0]).toMatchObject({ citation: 'IBC 2021 Section 1020.3, Table 1020.3', severity: 'high', status: 'fail' });
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'EGR-1020.5', reason: 'no_evidence' }),
        expect.objectContaining({ ruleId: 'FIR-1023.2', reason: 'quote_not_in_source' }),
        expect.objectContaining({ ruleId: 'ADA-405.2', reason: 'not_applicable' }),
        expect.objectContaining({ ruleId: 'XYZ-1', reason: 'unknown_rule' }),
      ]),
    );
  });
});

/**
 * Scripted reviewer standing in for the LLM: answers every rule it is asked about from a table of
 * expected outcomes on the demo plan. One deliberately hallucinated quote checks the rejection path.
 */
const EXPECTED: Record<string, { status: string; quote: string; fix?: string }> = {
  'EGR-1020.3': { status: 'fail', quote: 'Corridor clear width: 40 in. minimum at all residential corridors.', fix: 'Widen corridors to 44 in. clear.' },
  'EGR-1020.5': { status: 'fail', quote: 'West wing corridor terminates in a dead end 55 ft long beyond the last exit access point.', fix: 'Reduce the dead end to 50 ft or less.' },
  'EGR-1007.1.1': { status: 'fail', quote: 'Stair 1 and Stair 2 entrances are 38 ft apart measured in a straight line.', fix: 'Separate exits by at least 60 ft (1/3 of 180 ft).' },
  'EGR-1006.2.1': { status: 'pass', quote: 'Common path of egress travel from unit 214: 60 ft.' },
  'EGR-1017.2': { status: 'pass', quote: 'Max travel distance to an exit: 190 ft (sprinklered).' },
  'FIR-1020.2': { status: 'pass', quote: 'Corridor walls: 1-hour fire-resistance-rated, UL U419' },
  'FIR-714.4': { status: 'fail', quote: 'Penetrations of rated corridor walls: see FP-101 (firestop systems to be submitted).', fix: 'Specify listed firestop systems.' },
  'FIR-1023.2': { status: 'needs_review', quote: 'Stair enclosures are 1-hour rated.' }, // hallucinated: not in A-201
  'ADA-404.2.7': { status: 'pass', quote: 'Door hardware: lever handles mounted 34-48 in. above finished floor.' },
  'STR-ACI-20.5.1.3': { status: 'pass', quote: 'Clear cover 3 in. to earth.' },
  'STR-ACI-19.2.1': { status: 'pass', quote: "f'c = 4,000 psi at 28 days" },
  'PRM-107.2.2': { status: 'fail', quote: 'schedule TO BE SUBMITTED', fix: 'Submit the firestop schedule before installation.' },
};

function scriptedProvider(): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const user = req.messages.find((m) => m.role === 'user')!.content;
      const ids = [...user.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]);
      const findings = ids.map((id) => {
        const e = EXPECTED[id];
        return e
          ? { ruleId: id, status: e.status, evidenceQuote: e.quote, confidence: 0.86, suggestedFix: e.fix ?? '', reasoning: `checked ${id}` }
          : { ruleId: id, status: 'not_applicable', evidenceQuote: '', confidence: 0.9, suggestedFix: '', reasoning: 'not on this sheet' };
      });
      return { text: '', toolCalls: [{ id: 't', name: 'report_findings', arguments: { findings } }], finishReason: 'tool_use', usage: { input: 100, output: 50 } };
    },
  };
}

describe('plan review pipeline on the demo plan', () => {
  it('finds the planted egress problems on A-201 and discards the hallucinated quote', async () => {
    const provider = scriptedProvider();
    const rules = selectRules(RULES, meta, A201.discipline);
    const progress: number[] = [];
    const result = await evaluateSheet(A201, meta, rules, { provider, batchSize: 6, onProgress: (d) => void progress.push(d) });

    const fails = result.findings.filter((f) => f.status === 'fail').map((f) => f.ruleId);
    expect(fails).toEqual(expect.arrayContaining(['EGR-1020.3', 'EGR-1020.5', 'EGR-1007.1.1', 'FIR-714.4']));
    expect(result.findings.find((f) => f.ruleId === 'FIR-1023.2')).toBeUndefined();
    expect(result.rejected).toContainEqual(expect.objectContaining({ ruleId: 'FIR-1023.2', reason: 'quote_not_in_source' }));
    // Every accepted finding carries a verbatim quote, a citation and a severity.
    for (const f of result.findings) {
      expect(quoteFoundIn(f.evidenceQuote, A201.text)).toBe(true);
      expect(f.citation.length).toBeGreaterThan(5);
    }
    // Fails sorted first, passes last, no suggested fix on passes.
    expect(result.findings[0].status).toBe('fail');
    expect(result.findings.filter((f) => f.status === 'pass').every((f) => f.suggestedFix === '')).toBe(true);
    // Batched: ceil(rules/6) LLM calls, progress reported.
    expect(provider.calls.length).toBe(Math.ceil(rules.length / 6));
    expect(progress.at(-1)).toBe(Math.ceil(rules.length / 6));
    expect(result.usage.input).toBe(100 * provider.calls.length);
  });

  it('checks structural rules against S-101 without the rebar contradiction leaking in', async () => {
    const result = await evaluateSheet(S101, meta, selectRules(RULES, meta, S101.discipline), { provider: scriptedProvider() });
    expect(result.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['STR-ACI-20.5.1.3', 'STR-ACI-19.2.1']));
    expect(result.findings.every((f) => f.status === 'pass')).toBe(true);
  });

  it('flags the deferred fire protection submittal on FP-101', async () => {
    const result = await evaluateSheet(FP101, meta, selectRules(RULES, meta, FP101.discipline), { provider: scriptedProvider() });
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'PRM-107.2.2', status: 'fail', evidenceQuote: 'schedule TO BE SUBMITTED' }));
  });

  it('prompt carries project facts, sheet text and each rule test', () => {
    const rules = selectRules(RULES, meta, 'Architectural').slice(0, 2);
    const p = buildUserPrompt(A201, meta, rules);
    expect(p).toContain('Occupancy: M, R-2');
    expect(p).toContain('Sprinklered: yes');
    expect(p).toContain('Corridor clear width: 40 in.');
    for (const r of rules) expect(p).toContain(r.test);
  });
});
