import { useCallback, useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { call } from './api';
import { EmptyState, ErrorState, fmtDate, fmtDateTime, Skeleton } from './ui';

interface Graph {
  available: boolean;
  reason?: string;
  people: { id: string; name: string; roles: string[] }[];
  decisions: { issueKey: string; who: string; text: string; at: string | null; url: string | null }[];
  docs: { title: string; url: string | null; owner: string }[];
  similar: { key: string; summary: string; status: string | null }[];
  portal: { recordId: string; title: string; status: string; detail: string; official: string; date: string; project: string }[];
  connector: { connected: boolean; lastSync: string | null; accepted: number };
  fetchedAt: string;
}
interface Briefing {
  headline: string;
  points: string[];
  nextStep: string;
  talkTo: string[];
}

export function GraphContext() {
  const [data, setData] = useState<{ issueKey: string; graph: Graph; demoContextSeeded: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cmp, setCmp] = useState<{ without: Briefing; withGraph: Briefing } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await call('getIssueContext'));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const compare = async () => {
    setBusy('compare');
    setError(null);
    try {
      const r = await call<{ ok: boolean; without?: Briefing; withGraph?: Briefing; error?: string }>('compareBriefing');
      if (r.ok && r.without && r.withGraph) setCmp({ without: r.without, withGraph: r.withGraph });
      else setError(r.error ?? 'Briefing failed');
    } finally {
      setBusy(null);
    }
  };

  const seed = async () => {
    setBusy('seed');
    try {
      const r = await call<{ ok: boolean; comments?: number; pages?: number; note?: string; error?: string; confluenceError?: string }>('seedGraphContext', { withConfluence: true });
      setNote(r.ok ? `Added ${r.comments} decision comment(s) and ${r.pages} spec page(s). ${r.confluenceError ? `Confluence: ${r.confluenceError}. ` : ''}${r.note}` : (r.error ?? 'Failed'));
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={5} label="Loading Teamwork Graph context" />;
  const g = data.graph;
  const empty = !g.decisions.length && !g.people.length && !g.docs.length && !g.similar.length;

  return (
    <div className="fm-review">
      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}

      <section className="fm-card" aria-labelledby="cmp-h">
        <div className="fm-findings-head">
          <h2 id="cmp-h">Why the graph matters</h2>
          <button className="fm-btn" onClick={compare} disabled={!!busy}>
            {busy === 'compare' ? 'Writing both briefings…' : 'Compare briefing with and without Teamwork Graph'}
          </button>
        </div>
        <p className="fm-fine">Same model, same Jira and Foreman facts. The right column also gets people, decisions, specs and city records from Teamwork Graph.</p>
        {cmp && (
          <div className="fm-compare">
            <BriefingCard title="Without Teamwork Graph" b={cmp.without} />
            <BriefingCard title="With Teamwork Graph" b={cmp.withGraph} highlight />
          </div>
        )}
      </section>

      <section className="fm-card" aria-labelledby="ctx-h">
        <div className="fm-findings-head">
          <h2 id="ctx-h">Context from Teamwork Graph</h2>
          <span className={`fm-pill fm-pill--${g.available ? 'ok' : 'warn'}`}>{g.available ? 'Connected' : 'Unavailable'}</span>
        </div>
        {!g.available && <p className="fm-muted">{g.reason ?? 'Teamwork Graph did not answer.'} An org admin must grant the Teamwork Graph scopes for this app.</p>}
        {g.available && empty && (
          <EmptyState title="Nothing related in the graph yet">
            New comments and pages take a few minutes to reach Teamwork Graph.
            {!data.demoContextSeeded && ' For the demo, add decision records and spec pages below.'}
          </EmptyState>
        )}

        {g.decisions.length > 0 && (
          <>
            <h3 className="fm-h3">Who decided what</h3>
            <ul className="fm-ctx-list">
              {g.decisions.map((d, i) => (
                <li key={i}>
                  <strong>{d.who}</strong> on{' '}
                  <button className="fm-link" onClick={() => router.open(`/browse/${d.issueKey}`)}>
                    {d.issueKey}
                  </button>
                  {d.at ? <span className="fm-muted"> · {fmtDate(d.at)}</span> : null}
                  <div className="fm-excerpt">{d.text}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        {g.people.length > 0 && (
          <>
            <h3 className="fm-h3">People involved</h3>
            <ul className="fm-chips">
              {g.people.map((p) => (
                <li key={p.id} className="fm-chip" title={p.roles.join(', ')}>
                  {p.name} <span className="fm-muted">· {p.roles[0]}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {g.docs.length > 0 && (
          <>
            <h3 className="fm-h3">Relevant specs and pages</h3>
            <ul className="fm-ctx-list">
              {g.docs.map((d) => (
                <li key={d.title}>
                  {d.url ? (
                    <button className="fm-link" onClick={() => router.open(d.url!)}>
                      {d.title}
                    </button>
                  ) : (
                    d.title
                  )}{' '}
                  <span className="fm-muted">by {d.owner}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {g.similar.length > 0 && (
          <>
            <h3 className="fm-h3">Similar work in this project</h3>
            <ul className="fm-ctx-list">
              {g.similar.map((s) => (
                <li key={s.key}>
                  <button className="fm-link" onClick={() => router.open(`/browse/${s.key}`)}>
                    {s.key}
                  </button>{' '}
                  {s.summary} <span className="fm-muted">· {s.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {g.portal.length > 0 && (
          <>
            <h3 className="fm-h3">City permit portal records</h3>
            <p className="fm-fine">
              Ingested into Teamwork Graph by the "City permit portal (demo)" connector{' '}
              {g.connector.connected ? `(last sync ${g.connector.lastSync ? fmtDateTime(g.connector.lastSync) : 'pending'}, ${g.connector.accepted} records)` : '(not connected yet; an admin connects it in Atlassian Administration > Connected apps)'}.
            </p>
            <ul className="fm-ctx-list">
              {g.portal.map((r) => (
                <li key={r.recordId}>
                  <strong>{r.recordId}</strong> {r.title} <span className="fm-muted">· {fmtDate(r.date)} · {r.official}</span>
                  <div className="fm-excerpt">
                    {r.status}. {r.detail}
                    {r.project !== 'Riverside Commons' ? ` (precedent from ${r.project})` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="fm-actions">
          <button className="fm-btn fm-btn--subtle" onClick={load} disabled={!!busy}>
            Refresh
          </button>
          {!data.demoContextSeeded && (
            <button className="fm-btn fm-btn--subtle" onClick={seed} disabled={!!busy}>
              {busy === 'seed' ? 'Adding…' : 'Add demo decisions and spec pages'}
            </button>
          )}
        </div>
        {note && <p className="fm-muted">{note}</p>}
      </section>
    </div>
  );
}

function BriefingCard({ title, b, highlight }: { title: string; b: Briefing; highlight?: boolean }) {
  return (
    <article className={`fm-brief${highlight ? ' fm-brief--graph' : ''}`} aria-label={title}>
      <h3>{title}</h3>
      <p>
        <strong>{b.headline}</strong>
      </p>
      <ul>
        {b.points.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
      {b.talkTo.length > 0 && (
        <p className="fm-small">
          <strong>Talk to:</strong> {b.talkTo.join(', ')}
        </p>
      )}
      <p className="fm-small">
        <strong>Next:</strong> {b.nextStep}
      </p>
    </article>
  );
}
