import { z } from 'zod';
import { MonIssue } from '../services/monitor/detect';

/**
 * Input resolution for Rovo actions. Inputs come from the LLM and are untrusted:
 * identity always comes from `context.accountId`; issue/project keys prefer the deterministic
 * `payload.context.jira` the platform passes when the chat is opened on a project or issue.
 */

export interface ActionPayload {
  [k: string]: unknown;
  context?: { jira?: { issueKey?: string; projectKey?: string } };
}
export interface ActionContext {
  accountId?: string;
}

const projectKeyRe = /^[A-Z][A-Z0-9_]{1,9}$/;
const issueKeyRe = /^[A-Z][A-Z0-9_]{1,9}-\d+$/;

export function resolveProjectKey(payload: ActionPayload): string | null {
  const fromCtx = payload.context?.jira?.projectKey;
  if (fromCtx && projectKeyRe.test(fromCtx)) return fromCtx;
  const fromIssue = payload.context?.jira?.issueKey;
  if (fromIssue && issueKeyRe.test(fromIssue)) return fromIssue.split('-')[0];
  const fromInput = z.string().optional().safeParse(payload.projectKey);
  const v = fromInput.success ? fromInput.data?.trim().toUpperCase() : undefined;
  return v && projectKeyRe.test(v) ? v : null;
}

export const str = (v: unknown, max = 500): string | undefined => {
  const p = z.string().trim().min(1).max(max).safeParse(v);
  return p.success ? p.data : undefined;
};

const STOP = new Set(['the', 'our', 'a', 'an', 'for', 'of', 'on', 'to', 'is', 'what', 'whats', 'blocking', 'inspection', 'permit', 'please', 'level', 'levels']);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));

/**
 * Resolve a human reference ("framing inspection", "permit P-2", "FMD-9", "RFI-4", "A-201 review")
 * to one work item. Exact keys win; then summary prefixes like "P-2"/"RFI-4"; then token overlap,
 * preferring the kind the user named.
 */
export function resolveIssueRef(ref: string, issues: MonIssue[]): MonIssue | null {
  const raw = ref.trim();
  const upper = raw.toUpperCase();
  const exact = issues.find((i) => i.key === upper);
  if (exact) return exact;

  // Short codes used in summaries: P-2, RFI-4, I-5...
  const code = upper.match(/\b(P|RFI|PI|CF)-?\s?(\d{1,3})\b/);
  if (code) {
    const prefix = `${code[1]}-${code[2]}`;
    const hit = issues.find((i) => i.summary.toUpperCase().startsWith(`${prefix} `));
    if (hit) return hit;
  }

  const wantKind = /permit/i.test(raw) ? 'Permit' : /inspection/i.test(raw) ? 'Inspection' : /\brfi\b/i.test(raw) ? 'RFI' : /punch/i.test(raw) ? 'Punch Item' : null;
  const want = tokens(raw);
  if (!want.length && !wantKind) return null;
  let best: { i: MonIssue; score: number } | null = null;
  for (const i of issues) {
    const have = new Set(tokens(i.summary));
    let score = want.filter((t) => have.has(t)).length * 10;
    if (wantKind && i.kind === wantKind) score += 4;
    if (score > 0 && (!best || score > best.score)) best = { i, score };
  }
  return best && best.score >= 10 ? best.i : null;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date');
