import { z } from 'zod';
import { audit } from '../lib/audit';
import { gatherInspection } from './inspectionData';
import { generateReport } from './inspectionReport';
import { saveReport } from './reports';

export const EvidenceReportInput = z.object({
  projectKey: z.string(),
  issueKey: z.string(),
  requestedBy: z.string().nullable(),
  contextNotes: z.array(z.string().max(400)).max(10).default([]),
});

/** Async consumer job: gather evidence, run the LLM mapping, apply checks, store a draft report. */
export async function runEvidenceReportJob(jobId: number, raw: Record<string, unknown>, progress: (pct: number, msg?: string) => Promise<void>) {
  const input = EvidenceReportInput.parse(raw);
  await progress(5, 'Collecting notes, transcripts, photos and permit data');
  const { ctx, evidence } = await gatherInspection(input.issueKey, input.projectKey);
  const notes = evidence.filter((e) => e.kind !== 'photo').length;
  const photos = evidence.length - notes;
  if (!notes && !photos) throw new Error('No field notes, transcripts or photos on this work item yet. Add a field note or attach photos first.');
  await progress(30, `Mapping ${notes} note(s) and ${photos} photo(s) to ${ctx.checklist.length} checklist items`);
  const report = await generateReport(ctx, evidence, { contextNotes: input.contextNotes });
  await progress(90, 'Saving draft report');
  const reportId = await saveReport(input.projectKey, input.issueKey, jobId, report, input.requestedBy);
  await audit({
    actorAccountId: input.requestedBy,
    actorKind: 'agent',
    action: 'report.drafted',
    target: input.issueKey,
    after: { reportId, counts: report.counts, recommendation: report.recommendation, dropped: report.dropped, usage: report.usage },
  });
  return { reportId, counts: report.counts, recommendation: report.recommendation };
}
