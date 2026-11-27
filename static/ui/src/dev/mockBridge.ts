/**
 * Local preview stand-in for @forge/bridge. Serves fixtures built from Foreman's real services
 * (scripts/ui-fixtures.ts) so every screen can be reviewed without a Jira site.
 * Scenario comes from the URL hash: #cc, #cc-new, #cc-error, #panel-6, #panel-9, #panel-slow.
 */
import fx from './fixtures.json';

const scenario = () => location.hash.replace('#', '') || 'cc';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const state = { pending: clone(fx.overview.pending) as { id: number }[], recent: [] as unknown[] };

export async function invoke<T = unknown>(key: string, payload?: Record<string, unknown>): Promise<T> {
  const s = scenario();
  await wait(s === 'panel-slow' ? 2500 : 250);
  if (s === 'cc-error' && key === 'getMonitorOverview') throw new Error('Jira is not responding (HTTP 503). Try again in a minute.');
  const issue = s === 'panel-6' ? 'FMD-6' : 'FMD-9';
  const map: Record<string, unknown> = {
    getStatus: { ...fx.status, projectKey: s === 'cc-new' ? 'KAN' : 'FMD', issueKey: s.startsWith('panel') ? issue : null },
    getMonitorOverview: s === 'cc-new' ? { monitored: false, projectKey: 'KAN' } : { ...fx.overview, pending: state.pending, recent: state.recent },
    getOnboarding: s === 'cc-new' ? fx.onboardingNew : fx.onboardingLoaded,
    getVisuals: fx.visuals,
    getDemoStatus: s === 'cc-new' ? fx.demoStatusNew : { ...fx.demoStatusNew, loaded: true, completed: ['finalize'], steps: fx.demoStatusNew.steps.map((x) => ({ ...x, done: true })), issueCount: 25 },
    listAudit: fx.audit,
    getGraphConnector: { connected: true, name: 'City permit portal (demo)', connectedAt: new Date().toISOString(), lastSync: { at: new Date().toISOString(), accepted: 9, rejected: 0 } },
    getReviewContext: { ...fx.reviewContext, issueKey: issue },
    getEvidenceContext: issue === 'FMD-6' ? fx.evidenceContext : { ...fx.evidenceContext, issueKey: 'FMD-9', report: null, notes: [], photos: [] },
    getIssueContext: { issueKey: issue, graph: fx.graph, demoContextSeeded: true },
    compareBriefing: fx.briefings,
    listConfluenceSpaces: { ok: true, spaces: [{ id: '1', key: 'FRMN', name: 'Foreman Inspection Reports' }] },
    runMonitorNow: { jobId: 77 },
    startPlanReview: { jobId: 78 },
    startEvidenceReport: { jobId: 79 },
    startPingJob: { jobId: 80 },
    getJob: { id: Number(payload?.jobId ?? 1), kind: 'x', state: 'done', progress: 100, message: 'Done', result: {}, error: null },
    dismissOnboarding: { ok: true },
    saveMonitorConfig: fx.overview.config,
  };
  if (key === 'decideProposal') {
    const id = Number(payload?.id);
    const p = state.pending.find((x) => x.id === id);
    state.pending = state.pending.filter((x) => x.id !== id);
    if (p) state.recent.unshift({ ...p, state: payload?.decision === 'approve' ? 'executed' : 'rejected', decidedAt: new Date().toISOString() });
    return { ok: true } as T;
  }
  if (key in map) return clone(map[key]) as T;
  console.warn(`[mock] no fixture for ${key}`);
  return { ok: true } as T;
}

export const view = {
  theme: { enable: async () => undefined },
  getContext: async () => ({
    localId: 'ari:cloud:ecosystem::extension/53d4112c-bcbe-4a7e-ade7-a44df94a6995/0d4c8705-eb66-4c76-93e8-79a3efc0adb1/static/x',
    extension: scenario().startsWith('panel') ? { issue: { key: scenario() === 'panel-6' ? 'FMD-6' : 'FMD-9', type: 'Inspection' }, project: { key: 'FMD' } } : { project: { key: 'FMD' } },
  }),
};

export const router = {
  open: async (url: string) => console.info(`[mock] open ${url}`),
  navigate: async (url: string) => console.info(`[mock] navigate ${url}`),
};

/** Thumbnails: serve the demo photos from the dev folder. */
export async function requestJira(path: string): Promise<Response> {
  const id = path.match(/thumbnail\/(\w+)/)?.[1];
  const file = id === '201' ? 'rebar' : 'framing';
  return fetch(new URL(`./photos/${file}.jpg`, import.meta.url));
}
