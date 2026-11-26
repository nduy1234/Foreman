import { z } from 'zod';
import { audit } from '../lib/audit';
import { ProjectMeta } from '../lib/schemas';
import { RULES, RULE_PACK_VERSION } from '../rules';
import { saveReview } from './findings';
import { evaluateSheet, selectRules } from './planReview';
import { downloadAttachment, extractPdfText } from './pdfText';
import { getPlanSheet, getProjectMeta, savePlanSheet } from './projectData';

export const PlanReviewInput = z.object({
  projectKey: z.string(),
  issueKey: z.string(),
  sheetIds: z.array(z.string()).default([]),
  pdf: z
    .object({
      attachmentId: z.string(),
      sheetId: z.string().min(1).max(32),
      title: z.string().min(1).max(255),
      discipline: z.string().nullable(),
    })
    .optional(),
  requestedBy: z.string().nullable(),
});
export type PlanReviewInput = z.infer<typeof PlanReviewInput>;

/** Async consumer job (≤ 900 s): optional PDF import, then rule selection + LLM review per sheet. */
export async function runPlanReviewJob(
  jobId: number,
  rawInput: Record<string, unknown>,
  progress: (pct: number, msg?: string) => Promise<void>,
) {
  const input = PlanReviewInput.parse(rawInput);
  const meta: ProjectMeta | null = await getProjectMeta(input.projectKey);
  if (!meta) throw new Error('Project details (occupancy, construction type, stories) are not set. Add them in the Code Review panel first.');

  const sheetIds = [...input.sheetIds];
  if (input.pdf) {
    await progress(3, 'Extracting text from PDF');
    const bytes = await downloadAttachment(input.pdf.attachmentId);
    const { text, pages } = await extractPdfText(bytes);
    await savePlanSheet(input.projectKey, {
      sheetId: input.pdf.sheetId,
      title: input.pdf.title,
      discipline: input.pdf.discipline,
      text,
      source: 'pdf',
    });
    await progress(8, `Extracted ${pages} page(s) from PDF`);
    if (!sheetIds.includes(input.pdf.sheetId)) sheetIds.push(input.pdf.sheetId);
  }
  if (!sheetIds.length) throw new Error('No plan sheet selected');

  const summary: { sheetId: string; rulesChecked: number; findings: number; fail: number; needsReview: number; pass: number; rejected: number }[] = [];
  for (let s = 0; s < sheetIds.length; s++) {
    const sheet = await getPlanSheet(input.projectKey, sheetIds[s]);
    if (!sheet) throw new Error(`Plan sheet ${sheetIds[s]} not found`);
    const rules = selectRules(RULES, meta, sheet.discipline);
    const base = 10 + (80 * s) / sheetIds.length;
    const span = 80 / sheetIds.length;
    await progress(base, `Checking ${sheet.sheetId} against ${rules.length} rules`);
    const result = await evaluateSheet(
      { sheetId: sheet.sheetId, title: sheet.title, discipline: sheet.discipline, text: sheet.text },
      meta,
      rules,
      { onProgress: (done, total) => progress(base + (span * done) / total, `${sheet.sheetId}: ${done}/${total} rule batches`) },
    );
    await saveReview(input.projectKey, input.issueKey, jobId, result);
    const count = (st: string) => result.findings.filter((f) => f.status === st).length;
    summary.push({
      sheetId: sheet.sheetId,
      rulesChecked: result.rulesChecked,
      findings: result.findings.length,
      fail: count('fail'),
      needsReview: count('needs_review'),
      pass: count('pass'),
      rejected: result.rejected.filter((r) => r.reason !== 'not_applicable').length,
    });
    await audit({
      actorAccountId: input.requestedBy,
      actorKind: 'agent',
      action: 'plan_review.completed',
      target: input.issueKey,
      after: {
        jobId,
        sheetId: sheet.sheetId,
        rulePack: RULE_PACK_VERSION,
        model: result.model,
        rulesChecked: result.rulesChecked,
        accepted: result.findings.length,
        rejected: result.rejected.map((r) => `${r.ruleId}:${r.reason}`),
        usage: result.usage,
      },
    });
  }
  return { sheets: summary, rulePack: RULE_PACK_VERSION };
}
