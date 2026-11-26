import { migrationRunner, sql } from '@forge/sql';

/**
 * Forge SQL schema. Migrations are append-only: never edit a shipped entry, add a new one.
 * Run on install/upgrade lifecycle events and lazily before first use.
 */
export const MIGRATIONS: [name: string, ddl: string][] = [
  [
    'v001_audit_log',
    `CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      actor_account_id VARCHAR(128) NULL,
      actor_kind VARCHAR(16) NOT NULL,
      action VARCHAR(64) NOT NULL,
      target VARCHAR(255) NULL,
      proposal_id BIGINT NULL,
      before_json JSON NULL,
      after_json JSON NULL,
      INDEX idx_audit_target (target),
      INDEX idx_audit_ts (ts)
    )`,
  ],
  [
    'v002_jobs',
    `CREATE TABLE IF NOT EXISTS jobs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(32) NOT NULL,
      state VARCHAR(16) NOT NULL,
      progress INT NOT NULL DEFAULT 0,
      message VARCHAR(255) NULL,
      input_json JSON NULL,
      result_json JSON NULL,
      error TEXT NULL,
      created_by VARCHAR(128) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_jobs_kind_state (kind, state)
    )`,
  ],
  [
    'v003_proposals',
    `CREATE TABLE IF NOT EXISTS proposals (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(32) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      target_key VARCHAR(64) NULL,
      payload_json JSON NOT NULL,
      why TEXT NOT NULL,
      source VARCHAR(16) NOT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'pending',
      dedupe_key VARCHAR(191) NULL,
      created_by VARCHAR(128) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      decided_by VARCHAR(128) NULL,
      decided_at DATETIME(3) NULL,
      result_json JSON NULL,
      UNIQUE KEY uq_proposals_dedupe (dedupe_key),
      INDEX idx_proposals_project_state (project_key, state)
    )`,
  ],
  [
    'v004_plan_sets',
    `CREATE TABLE IF NOT EXISTS plan_sets (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(32) NOT NULL,
      sheet_id VARCHAR(32) NOT NULL,
      title VARCHAR(255) NOT NULL,
      discipline VARCHAR(64) NULL,
      text MEDIUMTEXT NOT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'pasted',
      seed_tag VARCHAR(32) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_plan_sets_sheet (project_key, sheet_id)
    )`,
  ],
  [
    'v005_evidence',
    `CREATE TABLE IF NOT EXISTS evidence (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(32) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      title VARCHAR(255) NULL,
      text MEDIUMTEXT NULL,
      author VARCHAR(128) NULL,
      captured_at DATETIME(3) NULL,
      attachment_id VARCHAR(32) NULL,
      comment_id VARCHAR(32) NULL,
      exif_json JSON NULL,
      seed_tag VARCHAR(64) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_evidence_issue (issue_key),
      UNIQUE KEY uq_evidence_seed (project_key, seed_tag)
    )`,
  ],
  [
    'v006_findings',
    `CREATE TABLE IF NOT EXISTS findings (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(32) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      sheet_id VARCHAR(32) NOT NULL,
      job_id BIGINT NULL,
      rule_id VARCHAR(64) NOT NULL,
      category VARCHAR(32) NOT NULL,
      title VARCHAR(255) NOT NULL,
      citation VARCHAR(255) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      evidence_quote TEXT NOT NULL,
      confidence DECIMAL(4,2) NOT NULL,
      suggested_fix TEXT NULL,
      reasoning TEXT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'open',
      created_issue_key VARCHAR(64) NULL,
      decided_by VARCHAR(128) NULL,
      decided_at DATETIME(3) NULL,
      decision_note VARCHAR(500) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_findings_issue (issue_key, state),
      INDEX idx_findings_project (project_key, state)
    )`,
  ],
  [
    'v007_inspection_reports',
    `CREATE TABLE IF NOT EXISTS inspection_reports (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(32) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      version INT NOT NULL,
      job_id BIGINT NULL,
      state VARCHAR(24) NOT NULL DEFAULT 'draft',
      report_json JSON NOT NULL,
      verified_count INT NOT NULL DEFAULT 0,
      needs_review_count INT NOT NULL DEFAULT 0,
      conflict_count INT NOT NULL DEFAULT 0,
      confluence_page_id VARCHAR(32) NULL,
      confluence_url VARCHAR(512) NULL,
      created_by VARCHAR(128) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      published_by VARCHAR(128) NULL,
      published_at DATETIME(3) NULL,
      signed_by VARCHAR(128) NULL,
      signed_at DATETIME(3) NULL,
      signoff_note VARCHAR(1000) NULL,
      UNIQUE KEY uq_reports_issue_version (issue_key, version),
      INDEX idx_reports_issue (issue_key)
    )`,
  ],
];

let schemaReady = false;

export async function runMigrations(): Promise<string[]> {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  const applied = await runner.run();
  schemaReady = true;
  return applied;
}

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await runMigrations();
}

export async function query<T>(text: string, ...params: unknown[]): Promise<T[]> {
  await ensureSchema();
  const res = await sql.prepare<T>(text).bindParams(...params).execute();
  return res.rows as T[];
}

export async function exec(text: string, ...params: unknown[]): Promise<{ insertId: number; affectedRows: number }> {
  await ensureSchema();
  const res = await sql.prepare<{ insertId: number; affectedRows: number }>(text).bindParams(...params).execute();
  const rows = res.rows as unknown as { insertId: number; affectedRows: number };
  return { insertId: Number(rows.insertId ?? 0), affectedRows: Number(rows.affectedRows ?? 0) };
}

/** JSON column helper: SQL JSON may come back as string or object depending on driver. */
export function parseJson<T = unknown>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}
