import { useCallback, useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { call, Job, Status, waitForJob } from './api';
import { DemoLoader } from './DemoLoader';
import { Diagnostics } from './Diagnostics';
import { Heatmap, HeatmapData } from './Heatmap';
import { ConnectorCard, Overview, Proposal, ProposalCard, Settings } from './Monitor';
import { Timeline, TimelineData } from './Timeline';
import { EmptyState, ErrorState, fmtDateTime, Lozenge, SectionTitle, Skeleton, Tabs } from './ui';

type Tab = 'overview' | 'approvals' | 'problems' | 'digest' | 'settings';
interface Visuals {
  timeline: TimelineData;
  heatmap: HeatmapData;
  issues: Record<string, { summary: string; kind: string; stage: string | null; risk: number }>;
}
interface Onboarding {
  dismissed: boolean;
  steps: { demoLoaded: boolean; monitorRan: boolean; reportDrafted: boolean; agentUsed: boolean; connectorConnected: boolean };
}
type Monitored = Extract<Overview, { monitored: true }>;

const open = (key: string) => router.open(`/browse/${key}`);
const SEV_TONE = { critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral' } as const;

export function CommandCenter() {
  const [status, setStatus] = useState<Status | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [vis, setVis] = useState<Visuals | null>(null);
  const [onb, setOnb] = useState<Onboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, o, ob] = await Promise.all([call<Status>('getStatus'), call<Overview>('getMonitorOverview'), call<Onboarding>('getOnboarding')]);
      setStatus(s);
      setOv(o);
      setOnb(ob);
      if (o.monitored) setVis(await call<Visuals>('getVisuals'));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const scan = async (digest = false) => {
    setError(null);
    try {
      const { jobId } = await call<{ jobId: number }>('runMonitorNow', { digest });
      setJob({ id: jobId, kind: 'monitor_scan', state: 'queued', progress: 0, message: 'Queued', result: null, error: null });
      const done = await waitForJob(jobId, setJob);
      if (done.state === 'failed') setError(done.error ?? 'Scan failed');
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const decide = async (p: Proposal, decision: 'approve' | 'reject', note?: string) => {
    setBusy(p.id);
    setError(null);
    try {
      const r = await call<{ ok: boolean; error?: string }>('decideProposal', { id: p.id, decision, note });
      if (!r.ok) setError(r.error ?? 'That did not work');
      else setNotice(decision === 'approve' ? `Approved #${p.id}: ${p.title}. Done in Jira and recorded in the audit log.` : `Rejected #${p.id}. Foreman will not propose it again.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (error && !ov) {
    return (
      <>
        <header className="fm-header">
          <h1>Foreman Command Center</h1>
        </header>
        <ErrorState message={error} onRetry={load} />
      </>
    );
  }
  if (!ov || !onb) {
    return (
      <>
        <Skeleton lines={2} label="Loading Command Center" />
        <div className="fm-card">
          <Skeleton lines={5} />
        </div>
      </>
    );
  }

  const showChecklist = !onb.dismissed && !Object.values(onb.steps).every(Boolean);

  if (!ov.monitored) {
    return (
      <>
        <header className="fm-header">
          <h1>Foreman Command Center</h1>
          <p className="fm-lede">Construction permits, inspections, code review and approvals, with AI that never acts without you.</p>
        </header>
        {error && <ErrorState message={error} onRetry={load} />}
        <Onboarding state={onb} projectKey={status?.projectKey ?? null} monitored={false} onChanged={load} />
      </>
    );
  }

  const o = ov as Monitored;
  const running = !!job && (job.state === 'queued' || job.state === 'running');
  const risk = o.risk;

  return (
    <>
      <header className="fm-header fm-header--cc">
        <div>
          <h1>{o.projectName}</h1>
          <p className="fm-lede">
            Foreman Command Center · {o.problems.length} open problem{o.problems.length === 1 ? '' : 's'} · {o.pending.length} waiting for approval
          </p>
        </div>
        <div className="fm-header-actions">
          <div className={`fm-gauge fm-gauge--sm fm-gauge--${risk?.band ?? 'low'}`} role="img" aria-label={`Project risk ${risk?.score ?? 0} of 100, ${risk?.band ?? 'low'}`}>
            <span>{risk?.score ?? '—'}</span>
          </div>
          <div>
            <button className="fm-btn" onClick={() => scan(false)} disabled={running} aria-describedby="scan-note">
              {running ? `Scanning ${job?.progress ?? 0}%` : 'Run monitor'}
            </button>
            <p id="scan-note" className="fm-fine fm-nomargin">
              {risk ? `Last scan ${fmtDateTime(risk.computedAt)}` : 'Not scanned yet'}
            </p>
          </div>
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={load} />}
      {showChecklist && <Onboarding state={onb} projectKey={o.projectKey} monitored onChanged={load} onScan={() => scan(false)} />}

      <Tabs<Tab>
        label="Command Center sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'approvals', label: 'Approval queue', count: o.pending.length },
          { id: 'problems', label: 'Problems', count: o.problems.length },
          { id: 'digest', label: 'Daily digest' },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      <div role="tabpanel" className="fm-tabpanel">
        {tab === 'overview' && (
          <>
            {risk ? (
              <section className="fm-card fm-risk-summary" aria-labelledby="why-h">
                <SectionTitle id="why-h">Why the risk is {risk.band}</SectionTitle>
                <p>{risk.why}</p>
                <div className="fm-actions">
                  {o.pending.length > 0 && (
                    <button className="fm-btn" onClick={() => setTab('approvals')}>
                      Review {o.pending.length} proposal{o.pending.length === 1 ? '' : 's'}
                    </button>
                  )}
                  <button className="fm-btn fm-btn--subtle" onClick={() => setTab('problems')}>
                    See all problems
                  </button>
                </div>
              </section>
            ) : (
              <EmptyState title="No scan yet" action={<button className="fm-btn" onClick={() => scan(false)} disabled={running}>Run monitor</button>}>
                The monitor checks inspection sequence, permit status and expiry, assignments, RFIs and contradictions.
              </EmptyState>
            )}
            {vis ? <Timeline data={vis.timeline} /> : <div className="fm-card"><Skeleton lines={6} label="Loading timeline" /></div>}
            {vis && <Heatmap data={vis.heatmap} issues={vis.issues} />}
          </>
        )}

        {tab === 'approvals' && (
          <section aria-labelledby="queue-h">
            <SectionTitle id="queue-h">Approval queue</SectionTitle>
            <p className="fm-lede">
              Foreman and the Rovo agent only propose. Nothing changes in Jira until you approve, and it runs as you. Every decision is in the audit log.
            </p>
            {notice && (
              <div className="fm-banner fm-banner--success" role="status">
                {notice}
              </div>
            )}
            {o.pending.length === 0 ? (
              <EmptyState title="Nothing waiting for approval">New proposals appear here after each monitor scan or when you ask Foreman in Rovo chat.</EmptyState>
            ) : (
              o.pending.map((p) => <ProposalCard key={p.id} p={p} busy={busy === p.id} onDecide={(d, n) => decide(p, d, n)} />)
            )}
            {o.recent.length > 0 && (
              <details className="fm-details">
                <summary>Recent decisions ({o.recent.length})</summary>
                <ul className="fm-audit">
                  {o.recent.map((p) => (
                    <li key={p.id}>
                      <Lozenge tone={p.state === 'executed' ? 'success' : p.state === 'failed' ? 'danger' : 'neutral'}>{p.state}</Lozenge> {p.title}{' '}
                      <span className="fm-muted">{fmtDateTime(p.decidedAt)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {tab === 'problems' && (
          <section aria-labelledby="prob-h">
            <SectionTitle id="prob-h">Open problems</SectionTitle>
            {o.problems.length === 0 ? (
              <EmptyState title="No open problems">The last scan found nothing to fix.</EmptyState>
            ) : (
              <ul className="fm-problems">
                {o.problems.map((p) => (
                  <li key={p.key} className={`fm-problem fm-problem--${p.severity}`}>
                    <div className="fm-problem-head">
                      <Lozenge tone={SEV_TONE[p.severity]}>{p.severity}</Lozenge>
                      <button className="fm-link" onClick={() => open(p.issueKey)}>
                        {p.issueKey}
                      </button>
                      <strong>{p.title}</strong>
                    </div>
                    <p className="fm-reason">{p.why}</p>
                    <p className="fm-fine fm-nomargin">
                      {p.detectorLabel}
                      {p.proposalId ? (
                        <>
                          {' · '}
                          <button className="fm-link" onClick={() => setTab('approvals')}>
                            proposal #{p.proposalId}
                          </button>
                        </>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === 'digest' && (
          <section className="fm-card" aria-labelledby="dig-h">
            <SectionTitle
              id="dig-h"
              extra={
                <button className="fm-btn fm-btn--subtle" onClick={() => scan(true)} disabled={running}>
                  {running ? 'Working…' : 'Scan and refresh digest'}
                </button>
              }
            >
              Daily digest {o.digest ? `· ${o.digest.date}` : ''}
            </SectionTitle>
            {o.digest ? <pre className="fm-digest">{o.digest.text}</pre> : <EmptyState title="No digest yet">The digest is written once a day after the morning scan.</EmptyState>}
          </section>
        )}

        {tab === 'settings' && (
          <>
            <Settings config={o.config} detectors={o.detectors} onSaved={load} />
            <ConnectorCard />
            <section className="fm-card" aria-labelledby="demo-h">
              <SectionTitle id="demo-h">Demo data</SectionTitle>
              <DemoLoader currentProjectKey={o.projectKey} />
            </section>
            <details className="fm-details">
              <summary>Health check and recent activity</summary>
              <Diagnostics embedded />
            </details>
          </>
        )}
      </div>
    </>
  );
}

function Onboarding({
  state,
  projectKey,
  monitored,
  onChanged,
  onScan,
}: {
  state: Onboarding;
  projectKey: string | null;
  monitored: boolean;
  onChanged: () => void;
  onScan?: () => void;
}) {
  const s = state.steps;
  const items: { done: boolean; title: string; body: string; action?: JSX.Element }[] = [
    { done: s.demoLoaded, title: 'Load the demo project', body: 'Riverside Commons: 4 permits, 8 inspections, RFIs, plan sheets, field notes and photos, with problems planted for Foreman to find.' },
    {
      done: s.monitorRan,
      title: 'Run the project monitor',
      body: 'Finds out-of-sequence inspections, stuck permits, aging RFIs and contradictions, and proposes fixes for you to approve.',
      action: monitored && onScan ? <button className="fm-btn fm-btn--subtle" onClick={onScan}>Run monitor</button> : undefined,
    },
    { done: s.reportDrafted, title: 'Draft a verified inspection report', body: 'Open an Inspection (for example the rebar inspection), open the Foreman panel and choose "Generate verified report".' },
    { done: s.agentUsed, title: 'Ask Foreman in Rovo chat', body: 'Open Rovo chat, pick the Foreman agent and try "What\'s blocking our framing inspection?".' },
    { done: s.connectorConnected, title: 'Optional: connect the city permit portal', body: 'An org admin connects it once in Atlassian Administration > Apps > Connected apps > Foreman > Connections.' },
  ];
  const doneCount = items.filter((i) => i.done).length;
  const dismiss = async () => {
    await call('dismissOnboarding');
    onChanged();
  };
  return (
    <section className="fm-card fm-onboarding" aria-labelledby="onb-h">
      <SectionTitle
        id="onb-h"
        extra={
          monitored ? (
            <button className="fm-btn fm-btn--subtle" onClick={dismiss}>
              Hide checklist
            </button>
          ) : undefined
        }
      >
        Get started with Foreman · {doneCount}/{items.length}
      </SectionTitle>
      <ol className="fm-checklist">
        {items.map((it, i) => (
          <li key={it.title} className={it.done ? 'is-done' : ''}>
            <span className="fm-check-dot" aria-hidden="true">
              {it.done ? '✓' : i + 1}
            </span>
            <div>
              <strong>{it.title}</strong>
              <span className="fm-sr">{it.done ? ' (done)' : ' (to do)'}</span>
              <p className="fm-muted fm-nomargin">{it.body}</p>
              {it.action && !it.done && <div className="fm-actions">{it.action}</div>}
              {i === 0 && !it.done && (
                <div className="fm-mt-s">
                  <DemoLoader currentProjectKey={projectKey} compact />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
