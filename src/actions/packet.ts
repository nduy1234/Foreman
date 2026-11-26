import { MonIssue, Problem } from '../services/monitor/detect';

/** Approval packet for a permit: everything a PM needs to sign off on the permit's status. Pure. */
export interface PacketInput {
  permit: MonIssue;
  conditions: string[];
  inspections: MonIssue[];
  openFindings: { ruleId: string; title: string; status: string; sheetId: string; citation: string }[];
  problems: Problem[];
  jurisdiction: string;
  today: string;
}

export function buildPermitPacket(p: PacketInput): { title: string; lines: string[]; readiness: 'ready' | 'not_ready'; blockers: string[] } {
  const permit = p.permit;
  const blockers: string[] = [];
  if (permit.stage !== 'Approved') blockers.push(`Permit is ${permit.stage ?? 'unknown'}, not Approved.`);
  for (const pr of p.problems) blockers.push(`${pr.severity.toUpperCase()}: ${pr.why}`);
  for (const f of p.openFindings.filter((f) => f.status === 'fail')) blockers.push(`Code finding ${f.ruleId} on ${f.sheetId}: ${f.title}`);

  const lines = [
    `APPROVAL PACKET - ${permit.summary} (${permit.key})`,
    `Permit number: ${permit.permitNo ?? 'n/a'} | Jurisdiction: ${p.jurisdiction} | Status: ${permit.stage ?? 'unknown'}`,
    `Submitted: ${permit.submittedOn ?? 'n/a'} | Expires: ${permit.expiresOn ?? 'n/a'} | Prepared: ${p.today}`,
    '',
    'CONDITIONS OF APPROVAL',
    ...(p.conditions.length ? p.conditions.map((c, i) => `${i + 1}. ${c}`) : ['None recorded.']),
    '',
    `INSPECTIONS UNDER THIS PERMIT (${p.inspections.length})`,
    ...p.inspections.map(
      (i) =>
        `- ${i.key} ${i.summary}: ${i.stage ?? 'unknown'}${i.scheduledFor ? `, scheduled ${i.scheduledFor}` : ''}${
          i.latestReport ? `, report v${i.latestReport.version} ${i.latestReport.state.replace('_', ' ')}` : ''
        }`,
    ),
    '',
    `OPEN CODE FINDINGS ON PERMIT SHEETS (${p.openFindings.length})`,
    ...(p.openFindings.length ? p.openFindings.map((f) => `- [${f.status}] ${f.ruleId} ${f.title} (${f.citation}, sheet ${f.sheetId})`) : ['None.']),
    '',
    `OPEN RISKS (${p.problems.length})`,
    ...(p.problems.length ? p.problems.map((pr) => `- [${pr.severity}] ${pr.why} Proposed: ${pr.proposal.title}.`) : ['None detected.']),
    '',
    blockers.length ? `READINESS: NOT READY - ${blockers.length} item(s) to resolve before sign-off.` : 'READINESS: Ready for project manager sign-off.',
    'Prepared by Foreman for human review. The jurisdiction has final authority over permits.',
  ];
  return { title: `Approval packet: ${permit.permitNo ?? permit.key}`, lines, readiness: blockers.length ? 'not_ready' : 'ready', blockers };
}
