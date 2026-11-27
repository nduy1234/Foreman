import { ReactNode, useCallback, useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { call, Job, waitForJob } from './api';
import { fmtDate } from './ui';

export interface Problem {
  key: string;
  detector: string;
  detectorLabel: string;
  issueKey: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  points: number;
  title: string;
  why: string;
  proposalId: number | null;
  firstSeen: string;
}
export interface Proposal {
  id: number;
  kind: 'reschedule' | 'notify' | 'escalate' | 'reinspect' | string;
  targetKey: string | null;
  title: string;
  payload: Record<string, unknown>;
  why: string;
  source: string;
  state: string;
  createdAt: string;
  decidedAt: string | null;
  result: unknown;
}
export interface Config {
  enabled: Record<string, boolean>;
  stuckReviewDays: number;
  expiryWarnDays: number;
  ackHours: number;
  noShowGraceDays: number;
  rfiAgeDays: number;
  rescheduleBufferDays: number;
  postComments: boolean;
  updateLabels: boolean;
}
export type Overview =
  | { monitored: false; projectKey: string }
  | {
      monitored: true;
      projectKey: string;
      projectName: string;
      risk: { score: number; band: 'low' | 'medium' | 'high'; why: string; counts: Record<string, number>; computedAt: string; problemCount: number } | null;
      problems: Problem[];
      pending: Proposal[];
      recent: Proposal[];
      topRisk: { issueKey: string; score: number; band: string; reasons: string[] }[];
      digest: { date: string; text: string } | null;
      config: Config;
      detectors: { id: string; label: string }[];
      lastJob: Job | null;
    };

const KIND_LABEL: Record<string, string> = { reschedule: 'Reschedule', notify: 'Notify', escalate: 'Escalate to city', reinspect: 'Re-inspect' };
const open = (key: string) => router.open(`/browse/${key}`);

export function Monitor({ notMonitored }: { notMonitored?: ReactNode }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      setOv(await call<Overview>('getMonitorOverview'));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const scan = async (digest = false) => {
    setError(null);
    const { jobId } = await call<{ jobId: number }>('runMonitorNow', { digest });
    const j: Job = { id: jobId, kind: 'monitor_scan', state: 'queued', progress: 0, message: 'Queued', result: null, error: null };
    setJob(j);
    await waitForJob(jobId, setJob).catch((e) => setError(String(e)));
    await load();
  };

  const decide = async (p: Proposal, decision: 'approve' | 'reject', note?: string) => {
    setBusy(p.id);
    setError(null);
    try {
      const r = await call<{ ok: boolean; error?: string }>('decideProposal', { id: p.id, decision, note });
      if (!r.ok) setError(r.error ?? 'Failed');
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!ov) return <p className="fm-muted">{error ?? 'Loading project monitor…'}</p>;
  if (!ov.monitored) {
    if (notMonitored) return <>{notMonitored}</>;
    return (
      <section className="fm-card">
        <h2>Project monitor</h2>
        <p className="fm-muted">
          Foreman monitors projects that have project details set. Load the demo project, or open a work item in {ov.projectKey} and set the project
          details in the Code review tab.
        </p>
      </section>
    );
  }

  const running = !!job && (job.state === 'queued' || job.state === 'running');
  const risk = ov.risk;

  return (
    <div className="fm-monitor">
      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}

      <section className="fm-card fm-risk" aria-labelledby="risk-h">
        <div className={`fm-gauge fm-gauge--${risk?.band ?? 'low'}`} role="img" aria-label={`Project risk ${risk?.score ?? 0} out of 100`}>
          <span>{risk?.score ?? '—'}</span>
          <small>/100</small>
        </div>
        <div className="fm-risk-body">
          <h2 id="risk-h">{ov.projectName} risk</h2>
          <p>{risk ? risk.why : 'No scan yet. Run the monitor to compute risk.'}</p>
          <p className="fm-fine">
            {risk ? `Last scan ${new Date(risk.computedAt).toLocaleString()} · ` : ''}scans hourly and after changes to permits, inspections and RFIs.
          </p>
          <div className="fm-actions">
            <button className="fm-btn" onClick={() => scan(false)} disabled={running}>
              {running ? `Scanning… ${job?.progress ?? 0}%` : 'Run monitor now'}
            </button>
            <button className="fm-btn fm-btn--subtle" onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? 'Hide rules' : 'Monitor rules'}
            </button>
          </div>
        </div>
      </section>

      {showSettings && <Settings config={ov.config} detectors={ov.detectors} onSaved={load} />}

      <ConnectorCard />

      <section aria-labelledby="queue-h">
        <h2 id="queue-h" className="fm-mt">
          Approval queue <span className="fm-count">{ov.pending.length}</span>
        </h2>
        <p className="fm-fine">Foreman never acts on its own. Each proposal runs only when you approve it, as you, and is recorded in the audit log.</p>
        {ov.pending.length === 0 && <p className="fm-muted">Nothing waiting for approval.</p>}
        {ov.pending.map((p) => (
          <ProposalCard key={p.id} p={p} busy={busy === p.id} onDecide={(d, n) => decide(p, d, n)} />
        ))}
      </section>

      <section aria-labelledby="prob-h">
        <h2 id="prob-h" className="fm-mt">
          Open problems <span className="fm-count">{ov.problems.length}</span>
        </h2>
        {ov.problems.length === 0 && <p className="fm-muted">No open problems.</p>}
        <ul className="fm-problems">
          {ov.problems.map((p) => (
            <li key={p.key} className={`fm-problem fm-problem--${p.severity}`}>
              <div className="fm-problem-head">
                <span className={`fm-sev fm-sev--${p.severity}`}>{p.severity}</span>
                <button className="fm-link" onClick={() => open(p.issueKey)}>
                  {p.issueKey}
                </button>
                <strong>{p.title}</strong>
              </div>
              <p className="fm-reason">{p.why}</p>
              <p className="fm-fine">{p.detectorLabel}</p>
            </li>
          ))}
        </ul>
      </section>

      {ov.topRisk.length > 0 && (
        <section aria-labelledby="top-h">
          <h2 id="top-h" className="fm-mt">
            Highest-risk work items
          </h2>
          <table className="fm-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Risk</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {ov.topRisk.map((r) => (
                <tr key={r.issueKey}>
                  <td>
                    <button className="fm-link" onClick={() => open(r.issueKey)}>
                      {r.issueKey}
                    </button>
                  </td>
                  <td>
                    <span className={`fm-pill fm-pill--${r.band === 'high' ? 'bad' : r.band === 'medium' ? 'warn' : 'ok'}`}>{r.score}</span>
                  </td>
                  <td className="fm-small">{r.reasons[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="fm-card fm-mt" aria-labelledby="dig-h">
        <div className="fm-findings-head">
          <h2 id="dig-h">Daily digest {ov.digest ? `· ${ov.digest.date}` : ''}</h2>
          <button className="fm-btn fm-btn--subtle" onClick={() => scan(true)} disabled={running}>
            Scan and refresh digest
          </button>
        </div>
        {ov.digest ? <pre className="fm-digest">{ov.digest.text}</pre> : <p className="fm-muted">The first digest is written after the daily scan.</p>}
      </section>

      {ov.recent.length > 0 && (
        <details className="fm-details">
          <summary>Recent decisions ({ov.recent.length})</summary>
          <ul className="fm-audit">
            {ov.recent.map((p) => (
              <li key={p.id}>
                <strong>{p.state}</strong> · {p.title} {p.decidedAt ? `· ${new Date(p.decidedAt).toLocaleString()}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ProposalCard({ p, busy, onDecide }: { p: Proposal; busy: boolean; onDecide: (d: 'approve' | 'reject', note?: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const details: string[] = [];
  const d = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : String(v));
  if (p.kind === 'reschedule' && p.payload.to) details.push(p.payload.from ? `Date: ${d(p.payload.from)} → ${d(p.payload.to)}` : `New date: ${d(p.payload.to)}`);
  if (p.kind === 'reinspect' && p.payload.to) details.push(`Re-inspection: ${d(p.payload.to)}`);
  if (p.payload.to && (p.kind === 'notify' || p.kind === 'escalate')) details.push(`To: ${p.payload.to}`);
  const source = p.source === 'agent' ? 'Proposed by Foreman in Rovo chat' : p.source === 'user' ? 'Proposed by a teammate' : 'Proposed by the Foreman monitor';
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(p.createdAt)) / 60000));
  const age = ageMin < 2 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : ageMin < 1440 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} d ago`;
  return (
    <article className="fm-proposal" aria-label={p.title}>
      <header>
        <span className="fm-chip">{KIND_LABEL[p.kind] ?? p.kind}</span>
        <strong>{p.title}</strong>
        {p.targetKey && (
          <button className="fm-link" onClick={() => open(p.targetKey!)}>
            {p.targetKey}
          </button>
        )}
      </header>
      <p className="fm-reason">{p.why}</p>
      {details.length > 0 && <p className="fm-cite">{details.join(' · ')}</p>}
      <p className="fm-fine fm-nomargin">
        #{p.id} · {source} · {age}
      </p>
      {typeof p.payload.message === 'string' && <blockquote className="fm-quote fm-quote--plain">{p.payload.message}</blockquote>}
      {!rejecting ? (
        <div className="fm-actions">
          <button className="fm-btn fm-btn--approve" disabled={busy} onClick={() => onDecide('approve')}>
            {busy ? 'Working…' : 'Approve'}
          </button>
          <button className="fm-btn fm-btn--subtle" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      ) : (
        <div className="fm-actions">
          <label className="fm-sr" htmlFor={`rj-${p.id}`}>
            Reason
          </label>
          <input id={`rj-${p.id}`} className="fm-input fm-input--inline" placeholder="Reason (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <button
            className="fm-btn"
            disabled={busy}
            onClick={() => {
              setRejecting(false);
              onDecide('reject', note || undefined);
            }}
          >
            Reject proposal
          </button>
          <button className="fm-btn fm-btn--subtle" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      )}
    </article>
  );
}

export function Settings({ config, detectors, onSaved }: { config: Config; detectors: { id: string; label: string }[]; onSaved: () => void }) {
  const [c, setC] = useState<Config>(config);
  const [msg, setMsg] = useState<string | null>(null);
  const num = (k: keyof Config, label: string, unit: string) => (
    <label>
      {label}
      <span className="fm-inline">
        <input className="fm-input fm-input--num" type="number" min={0} value={c[k] as number} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })} /> {unit}
      </span>
    </label>
  );
  const save = async () => {
    setMsg(null);
    try {
      await call('saveMonitorConfig', { config: c });
      setMsg('Saved. Run the monitor to apply.');
      onSaved();
    } catch (e) {
      setMsg(String((e as Error).message ?? e));
    }
  };
  return (
    <section className="fm-card" aria-labelledby="set-h">
      <h2 id="set-h">Monitor rules</h2>
      <div className="fm-grid">
        {num('stuckReviewDays', 'Permit stuck in review after', 'days')}
        {num('expiryWarnDays', 'Warn before permit expiry', 'days')}
        {num('ackHours', 'Assignment acknowledgement due within', 'hours')}
        {num('noShowGraceDays', 'No-show after scheduled date +', 'days')}
        {num('rfiAgeDays', 'RFI aging after', 'days')}
        {num('rescheduleBufferDays', 'Reschedule buffer after prerequisite', 'days')}
      </div>
      <fieldset className="fm-sheets">
        <legend>Checks</legend>
        {detectors.map((d) => (
          <label key={d.id} className="fm-check">
            <input type="checkbox" checked={c.enabled[d.id] !== false} onChange={(e) => setC({ ...c, enabled: { ...c.enabled, [d.id]: e.target.checked } })} />
            <span>{d.label}</span>
          </label>
        ))}
        <label className="fm-check">
          <input type="checkbox" checked={c.postComments} onChange={(e) => setC({ ...c, postComments: e.target.checked })} />
          <span>Post one comment on the work item when a problem is first found</span>
        </label>
        <label className="fm-check">
          <input type="checkbox" checked={c.updateLabels} onChange={(e) => setC({ ...c, updateLabels: e.target.checked })} />
          <span>Keep foreman-risk-* and foreman-flag-* labels up to date</span>
        </label>
      </fieldset>
      <div className="fm-actions">
        <button className="fm-btn" onClick={save}>
          Save rules
        </button>
        {msg && <span className="fm-muted">{msg}</span>}
      </div>
    </section>
  );
}

export function ConnectorCard() {
  const [c, setC] = useState<{ connected: boolean; name: string | null; lastSync: { at: string; accepted: number; rejected: number; error?: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => call<typeof c>('getGraphConnector').then(setC).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  if (!c) return null;
  const sync = async () => {
    setBusy(true);
    try {
      const { jobId } = await call<{ jobId: number }>('syncPortalNow');
      await waitForJob(jobId, () => undefined);
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fm-card fm-mt" aria-labelledby="twg-h">
      <div className="fm-findings-head">
        <h2 id="twg-h">Teamwork Graph: city permit portal</h2>
        <span className={`fm-pill fm-pill--${c.connected ? 'ok' : 'warn'}`}>{c.connected ? 'Connected' : 'Not connected'}</span>
      </div>
      {c.connected ? (
        <p className="fm-muted">
          {c.lastSync
            ? `Last sync ${new Date(c.lastSync.at).toLocaleString()}: ${c.lastSync.accepted} record(s) in Teamwork Graph${c.lastSync.rejected ? `, ${c.lastSync.rejected} rejected` : ''}.`
            : 'Connected; first sync pending.'}
        </p>
      ) : (
        <p className="fm-muted">
          Foreman adds plan-check events and inspection results from the city portal to Teamwork Graph, linked to permits, inspections and city
          officials, so Rovo and search can use them. An org admin connects it once: Atlassian Administration &gt; Apps &gt; Connected apps &gt;
          Foreman &gt; Connections &gt; City permit portal (demo) &gt; Connect.
        </p>
      )}
      {c.connected && (
        <div className="fm-actions">
          <button className="fm-btn fm-btn--subtle" onClick={sync} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync portal records now'}
          </button>
        </div>
      )}
    </section>
  );
}
