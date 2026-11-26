import { z } from 'zod';

/** Monitor rules. Stored per project in KVS (`monitor:config:<KEY>`); missing values fall back to defaults. */
export const DETECTORS = [
  'sequence_violation',
  'permit_not_approved',
  'stuck_review',
  'permit_expiring',
  'unacknowledged_assignment',
  'inspection_no_show',
  'status_contradiction',
  'rfi_aging',
] as const;
export type Detector = (typeof DETECTORS)[number];

export const DETECTOR_LABELS: Record<Detector, string> = {
  sequence_violation: 'Inspection scheduled before its prerequisite passes',
  permit_not_approved: 'Inspection depends on a permit that is not approved',
  stuck_review: 'Permit stuck in jurisdiction review',
  permit_expiring: 'Permit nearing expiry',
  unacknowledged_assignment: 'Contractor has not acknowledged an assignment',
  inspection_no_show: 'Inspection date passed with no result (no-show)',
  status_contradiction: 'Report / plan / Jira status contradiction',
  rfi_aging: 'RFI open too long',
};

export const MonitorConfig = z.object({
  enabled: z.partialRecord(z.enum(DETECTORS), z.boolean()).default({}),
  stuckReviewDays: z.number().int().min(1).max(180).default(10),
  expiryWarnDays: z.number().int().min(1).max(180).default(21),
  ackHours: z.number().int().min(1).max(720).default(48),
  noShowGraceDays: z.number().int().min(0).max(30).default(1),
  rfiAgeDays: z.number().int().min(1).max(180).default(7),
  rescheduleBufferDays: z.number().int().min(0).max(30).default(2),
  postComments: z.boolean().default(true),
  updateLabels: z.boolean().default(true),
});
export type MonitorConfig = z.infer<typeof MonitorConfig>;

export const DEFAULT_CONFIG: MonitorConfig = MonitorConfig.parse({});

export const isEnabled = (cfg: MonitorConfig, d: Detector) => cfg.enabled[d] !== false;
