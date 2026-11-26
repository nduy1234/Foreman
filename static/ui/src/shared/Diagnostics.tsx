import { useEffect, useState } from 'react';
import { AuditRow, call, Job, Status, waitForJob } from './api';

/** P1 wiring check: resolver, async queue + consumer, SQL, audit log. Replaced by real UI in later prompts. */
export function Diagnostics({ title, subtitle, embedded }: { title?: string; subtitle?: string; embedded?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);

  const loadAudit = () => call<AuditRow[]>('listAudit', { limit: 10 }).then(setAudit).catch((e) => setError(String(e)));

  useEffect(() => {
    call<Status>('getStatus')
      .then(setStatus)
      .catch((e) => setError(String(e)));
    loadAudit();
  }, []);

  const runPing = async () => {
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await call<{ jobId: number }>('startPingJob');
      await waitForJob(jobId, setJob);
      await loadAudit();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? '' : 'fm-page'}>
      {!embedded && (
        <header className="fm-header">
          <h1>{title}</h1>
          <p className="fm-muted">{subtitle}</p>
        </header>
      )}

      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}

      <section className="fm-card" aria-labelledby="status-h">
        <h2 id="status-h">Connection</h2>
        {status ? (
          <dl className="fm-dl">
            <dt>App version</dt>
            <dd>{status.version}</dd>
            <dt>Project</dt>
            <dd>{status.projectKey ?? '—'}</dd>
            <dt>Issue</dt>
            <dd>{status.issueKey ?? '—'}</dd>
          </dl>
        ) : (
          <p className="fm-muted">Connecting…</p>
        )}
        <button className="fm-btn" onClick={runPing} disabled={busy}>
          {busy ? 'Running background job…' : 'Run background job check'}
        </button>
        {job && (
          <p className="fm-muted" aria-live="polite">
            Job #{job.id}: {job.state} ({job.progress}%){job.error ? ` — ${job.error}` : ''}
          </p>
        )}
      </section>

      <section className="fm-card" aria-labelledby="audit-h">
        <h2 id="audit-h">Audit trail (latest)</h2>
        {audit.length === 0 ? (
          <p className="fm-muted">No activity yet.</p>
        ) : (
          <table className="fm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.ts).toLocaleString()}</td>
                  <td>{a.actorKind}</td>
                  <td>{a.action}</td>
                  <td>{a.target ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
