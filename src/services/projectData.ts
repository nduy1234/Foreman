import { kvs } from '@forge/kvs';
import { exec, query } from '../lib/db';
import { ProjectMeta } from '../lib/schemas';

/** Project metadata (occupancy, construction type...) lives in KVS per Jira project. */
export async function getProjectMeta(projectKey: string): Promise<ProjectMeta | null> {
  const raw = await kvs.get(`project:${projectKey}:meta`);
  const parsed = ProjectMeta.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveProjectMeta(projectKey: string, meta: ProjectMeta): Promise<ProjectMeta> {
  const existing = ((await kvs.get(`project:${projectKey}:meta`)) as Record<string, unknown> | undefined) ?? {};
  const value = { ...existing, ...ProjectMeta.parse(meta) };
  await kvs.set(`project:${projectKey}:meta`, value);
  return ProjectMeta.parse(value);
}

export interface PlanSheetRow {
  id: number;
  sheetId: string;
  title: string;
  discipline: string | null;
  text: string;
  source: string;
}

export async function listPlanSheets(projectKey: string, withText = false): Promise<PlanSheetRow[]> {
  const rows = await query<{ id: number; sheet_id: string; title: string; discipline: string | null; text: string; source: string }>(
    `SELECT id, sheet_id, title, discipline, ${withText ? 'text' : "'' AS text"}, source FROM plan_sets WHERE project_key = ? ORDER BY sheet_id`,
    projectKey,
  );
  return rows.map((r) => ({ id: Number(r.id), sheetId: r.sheet_id, title: r.title, discipline: r.discipline, text: r.text, source: r.source }));
}

export async function getPlanSheet(projectKey: string, sheetId: string): Promise<PlanSheetRow | null> {
  const rows = await listPlanSheets(projectKey, true);
  return rows.find((r) => r.sheetId === sheetId) ?? null;
}

export async function savePlanSheet(
  projectKey: string,
  sheet: { sheetId: string; title: string; discipline: string | null; text: string; source: 'pasted' | 'pdf' },
): Promise<void> {
  await exec(
    `INSERT INTO plan_sets (project_key, sheet_id, title, discipline, text, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), discipline = VALUES(discipline), text = VALUES(text), source = VALUES(source)`,
    projectKey,
    sheet.sheetId,
    sheet.title,
    sheet.discipline,
    sheet.text,
    sheet.source,
  );
}
