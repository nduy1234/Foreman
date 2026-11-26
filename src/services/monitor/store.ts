import { kvs, WhereConditions } from '@forge/kvs';
import { DEFAULT_CONFIG, MonitorConfig } from './config';

export async function getMonitorConfig(projectKey: string): Promise<MonitorConfig> {
  const raw = await kvs.get(`monitor:config:${projectKey}`);
  const parsed = MonitorConfig.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

export async function saveMonitorConfig(projectKey: string, cfg: unknown): Promise<MonitorConfig> {
  const value = MonitorConfig.parse(cfg);
  await kvs.set(`monitor:config:${projectKey}`, value);
  return value;
}

/** Projects Foreman monitors: any project with saved Foreman project details. */
export async function monitoredProjects(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith('project:')).limit(50);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany<unknown>();
    for (const r of page.results) {
      const m = r.key.match(/^project:([A-Z][A-Z0-9_]+):meta$/);
      if (m) keys.push(m[1]);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...new Set(keys)];
}

export interface ProjectRiskSummary {
  projectKey: string;
  score: number;
  band: 'low' | 'medium' | 'high';
  why: string;
  counts: Record<string, number>;
  computedAt: string;
  problemCount: number;
}

export const saveProjectRisk = (s: ProjectRiskSummary) => kvs.set(`monitor:project:${s.projectKey}`, s);
export const getProjectRisk = async (projectKey: string) => ((await kvs.get(`monitor:project:${projectKey}`)) as ProjectRiskSummary | undefined) ?? null;
