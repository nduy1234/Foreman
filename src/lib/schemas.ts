import { z } from 'zod';

/** Construction trades used across fields, rules, heatmap. */
export const Trade = z.enum([
  'Concrete',
  'Steel',
  'Framing',
  'Electrical',
  'Plumbing',
  'Mechanical',
  'Fire Protection',
  'Finishes',
  'General',
]);
export type Trade = z.infer<typeof Trade>;

export const ProjectMeta = z.object({
  name: z.string().min(1),
  occupancy: z.array(z.string()).min(1), // e.g. ["M", "R-2"]
  constructionType: z.string(), // e.g. "V-A over I-A"
  stories: z.number().int().positive(),
  areaSqft: z.number().positive(),
  jurisdiction: z.string(),
  sprinklered: z.boolean().default(true),
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;

export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

/** One curated code rule. Citations reference section numbers; tests are paraphrased. */
export const Rule = z.object({
  id: z.string().regex(/^[A-Z]{3}-[\w.-]+$/),
  category: z.enum(['egress', 'fire-separation', 'accessibility', 'structural', 'permit-prerequisite']),
  title: z.string(),
  citation: z.string(),
  severity: Severity,
  /** Plan disciplines this rule is checked against. Empty = all. */
  disciplines: z.array(z.enum(['Architectural', 'Structural', 'Fire Protection', 'MEP', 'Civil'])).default([]),
  appliesWhen: z
    .object({
      occupancy: z.array(z.string()).optional(),
      minStories: z.number().int().optional(),
      maxStories: z.number().int().optional(),
      constructionTypes: z.array(z.string()).optional(),
      sprinklered: z.boolean().optional(),
    })
    .default({}),
  test: z.string().min(10),
  evidenceHints: z.array(z.string()).default([]),
});
export type Rule = z.infer<typeof Rule>;

/** What the LLM must return for a single rule evaluation. */
export const LlmFinding = z.object({
  ruleId: z.string(),
  status: z.enum(['pass', 'fail', 'needs_review', 'not_applicable']),
  evidenceQuote: z.string(),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string().default(''),
  reasoning: z.string().default(''),
});
export type LlmFinding = z.infer<typeof LlmFinding>;

export const ProposalKind = z.enum([
  'reschedule',
  'notify',
  'escalate',
  'reinspect',
  'create_issue',
  'transition',
  'publish_report',
  'approve_permit',
  'comment',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const ProposalState = z.enum(['pending', 'approved', 'rejected', 'executed', 'failed']);
export type ProposalState = z.infer<typeof ProposalState>;

export const NewProposal = z.object({
  projectKey: z.string(),
  kind: ProposalKind,
  targetKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  why: z.string().min(1),
  source: z.enum(['monitor', 'agent', 'user']),
  createdBy: z.string().nullable(),
});
export type NewProposal = z.infer<typeof NewProposal>;

export const ActorKind = z.enum(['user', 'agent', 'monitor', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

export const AuditEntry = z.object({
  actorAccountId: z.string().nullable(),
  actorKind: ActorKind,
  action: z.string().min(1),
  target: z.string().nullable(),
  proposalId: z.number().int().nullable().default(null),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AuditEntry = z.input<typeof AuditEntry>;

export const JobKind = z.enum(['ping', 'seed', 'plan_review', 'evidence_report', 'monitor_scan', 'twg_sync']);
export type JobKind = z.infer<typeof JobKind>;
export const JobState = z.enum(['queued', 'running', 'done', 'failed']);
export type JobState = z.infer<typeof JobState>;

export const JobEventBody = z.object({
  jobId: z.number().int(),
  kind: JobKind,
  input: z.record(z.string(), z.unknown()).default({}),
});
export type JobEventBody = z.infer<typeof JobEventBody>;
