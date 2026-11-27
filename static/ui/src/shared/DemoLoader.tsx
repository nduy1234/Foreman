import { useEffect, useRef, useState } from 'react';
import { router, view } from '@forge/bridge';
import { call } from './api';

type StepId = 'config' | 'project' | 'issues' | 'workflow' | 'links' | 'evidence' | 'finalize';

export interface DemoStatus {
  projectKey: string;
  loaded: boolean;
  completed: StepId[];
  steps: { id: StepId; label: string; done: boolean }[];
  issueCount: number;
  loadedAt?: string;
}

type StepResult =
  | { ok: true; step: StepId | null; message: string; status: DemoStatus }
  | { ok: false; error: string; status: DemoStatus };

type ResetResult = { ok: true; deleted: number; remaining: number; status: DemoStatus } | { ok: false; error: string; status: DemoStatus };

/** Parse appId/envId from the extension localId so we can link to the demo project's Command Center. */
async function commandCenterPath(projectKey: string): Promise<string> {
  try {
    const ctx = (await view.getContext()) as { localId?: string };
    const m = ctx.localId?.match(/extension\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//);
    if (m) return `/jira/software/projects/${projectKey}/apps/${m[1]}/${m[2]}`;
  } catch {
    /* fall through */
  }
  return `/jira/software/projects/${projectKey}/list`;
}

/** `compact`: used inside the onboarding checklist (no own heading; steps appear once loading starts). */
export function DemoLoader({ currentProjectKey, compact = false }: { currentProjectKey: string | null; compact?: boolean }) {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    call<DemoStatus>('getDemoStatus').then(setStatus).catch((e) => setError(String(e)));
    return () => {
      cancelled.current = true;
    };
  }, []);

  const load = async () => {
    setRunning(true);
    setError(null);
    try {
      for (let guard = 0; guard < 12 && !cancelled.current; guard++) {
        const r = await call<StepResult>('runDemoStep', {});
        setStatus(r.status);
        if (!r.ok) {
          setError(r.error);
          break;
        }
        setMessage(r.message);
        if (r.step === null || r.status.loaded) break;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setRunning(true);
    setError(null);
    try {
      const r = await call<ResetResult>('resetDemo', { confirm: true });
      setStatus(r.status);
      if (!r.ok) setError(r.error);
      else setMessage(`Removed ${r.deleted} demo work items. Load the demo again to start fresh.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const openProject = async () => {
    if (!status) return;
    await router.navigate(await commandCenterPath(status.projectKey));
  };

  if (!status) {
    return (
      <section className="fm-card" aria-busy="true">
        <p className="fm-muted">Checking demo project…</p>
      </section>
    );
  }

  const doneCount = status.steps.filter((s) => s.done).length;
  const onDemoProject = currentProjectKey === status.projectKey;

  return (
    <section className={compact ? 'fm-demo-compact' : 'fm-demo'} aria-label="Demo project">
      {!compact && <p className="fm-lede">{status.loaded ? `Riverside Commons (${status.projectKey}) is loaded with ${status.issueCount} work items.` : ''}</p>}
      {!status.loaded && !compact && (
        <p className="fm-muted">
          Creates <strong>Riverside Commons</strong> ({status.projectKey}), a 5-story mixed-use project with 4 permits, 8 inspections, RFIs,
          punch items, plan sheets and field evidence, including a few planted problems for Foreman to find. Needs Jira admin. Takes about a
          minute.
        </p>
      )}

      {(running || (doneCount > 0 && !status.loaded)) && (
        <>
          <ol className="fm-steps" aria-label="Demo setup steps">
            {status.steps.map((s) => (
              <li key={s.id} className={s.done ? 'is-done' : ''}>
                <span aria-hidden="true">{s.done ? '✓' : '○'}</span> {s.label}
                <span className="fm-sr">{s.done ? ' (done)' : ''}</span>
              </li>
            ))}
          </ol>
          <div className="fm-progress" role="progressbar" aria-label="Demo setup progress" aria-valuemin={0} aria-valuemax={status.steps.length} aria-valuenow={doneCount}>
            <div style={{ width: `${(doneCount / status.steps.length) * 100}%` }} />
          </div>
        </>
      )}

      {message && (
        <p className="fm-muted" aria-live="polite">
          {message}
        </p>
      )}
      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}

      <div className="fm-actions">
        {!status.loaded && (
          <button className="fm-btn" onClick={load} disabled={running}>
            {running ? 'Loading demo project…' : doneCount > 0 ? 'Resume loading demo project' : 'Load demo project'}
          </button>
        )}
        {status.loaded && !onDemoProject && (
          <button className="fm-btn" onClick={openProject}>
            Open {status.projectKey} Command Center
          </button>
        )}
        {(status.loaded || doneCount > 0) && !confirmReset && (
          <button className="fm-btn fm-btn--subtle" onClick={() => setConfirmReset(true)} disabled={running}>
            Reset demo
          </button>
        )}
      </div>

      {confirmReset && (
        <div className="fm-confirm" role="alertdialog" aria-labelledby="reset-h">
          <p id="reset-h">
            <strong>Reset the demo?</strong> This permanently deletes the {status.issueCount} Foreman demo work items in {status.projectKey} plus
            their demo evidence and proposals. Your other projects are not touched. The audit log is kept.
          </p>
          <div className="fm-actions">
            <button className="fm-btn fm-btn--danger" onClick={reset}>
              Delete demo data
            </button>
            <button className="fm-btn fm-btn--subtle" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
