import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from '@forge/bridge';
import { AuditRow, call, Job, waitForJob } from './api';

type Status = 'pass' | 'fail' | 'needs_review';
type State = 'open' | 'dismissed' | 'approved' | 'ticketed';

interface Finding {
  id: number;
  sheetId: string;
  ruleId: string;
  category: string;
  title: string;
  citation: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: Status;
  evidenceQuote: string;
  confidence: number;
  suggestedFix: string | null;
  reasoning: string | null;
  state: State;
  createdIssueKey: string | null;
  decisionNote: string | null;
}

interface Meta {
  name: string;
  occupancy: string[];
  constructionType: string;
  stories: number;
  areaSqft: number;
  jurisdiction: string;
  sprinklered: boolean;
}

interface SheetInfo {
  sheetId: string;
  title: string;
  discipline: string | null;
  source: string;
  suggested: boolean;
  ruleCount: number | null;
}

interface ReviewContext {
  issueKey: string;
  projectKey: string;
  issueType: string | null;
  meta: Meta | null;
  sheets: SheetInfo[];
  pdfAttachments: { id: string; filename: string; size: number }[];
  findings: Finding[];
  job: Job | null;
  rulePack: { version: string; total: number };
}

const DISCIPLINES = ['Architectural', 'Structural', 'Fire Protection', 'MEP', 'Civil'] as const;
const STATUS_LABEL: Record<Status, string> = { fail: 'Fail', needs_review: 'Needs review', pass: 'Pass' };
const STATE_LABEL: Record<State, string> = { open: 'Open', dismissed: 'Dismissed', approved: 'Approved', ticketed: 'Tracked' };

type Filter = 'action' | 'pass' | 'closed' | 'all';

export function CodeReview() {
  const [ctx, setCtx] = useState<ReviewContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>('action');
  const [editingMeta, setEditingMeta] = useState(false);
  const [addingSheet, setAddingSheet] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  const load = useCallback(async () => {
    try {
      const c = await call<ReviewContext>('getReviewContext');
      setCtx(c);
      setSelected((prev) => (prev.length ? prev : c.sheets.filter((s) => s.suggested).map((s) => s.sheetId)));
      if (c.job && (c.job.state === 'queued' || c.job.state === 'running')) setJob(c.job);
      setAudit(await call<AuditRow[]>('listAudit', { target: c.issueKey, limit: 8 }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Resume polling a job that was already running when the panel opened.
  useEffect(() => {
    if (!job || job.state === 'done' || job.state === 'failed') return;
    let stop = false;
    waitForJob(job.id, (j) => {
      if (!stop) setJob(j);
    })
      .then(() => {
        if (!stop) load();
      })
      .catch((e) => {
        if (!stop) setError(String(e));
      });
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const startReview = async (pdf?: { attachmentId: string; sheetId: string; title: string; discipline: string | null }) => {
    setError(null);
    try {
      const { jobId } = await call<{ jobId: number }>('startPlanReview', { sheetIds: pdf ? [] : selected, pdf });
      setJob({ id: jobId, kind: 'plan_review', state: 'queued', progress: 0, message: 'Queued', result: null, error: null });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const act = async (f: Finding, action: 'create_issue' | 'dismiss' | 'approve' | 'reopen', note?: string) => {
    setBusyId(f.id);
    setError(null);
    try {
      const r = await call<{ ok: boolean; error?: string }>('findingAction', { id: f.id, action, note });
      if (!r.ok) setError(r.error ?? 'Action failed');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(() => {
    const f = ctx?.findings ?? [];
    const open = f.filter((x) => x.state === 'open');
    return {
      fail: open.filter((x) => x.status === 'fail').length,
      review: open.filter((x) => x.status === 'needs_review').length,
      pass: f.filter((x) => x.status === 'pass').length,
      closed: f.filter((x) => x.state !== 'open' && x.status !== 'pass').length,
    };
  }, [ctx]);

  const visible = useMemo(() => {
    const f = ctx?.findings ?? [];
    const order = { fail: 0, needs_review: 1, pass: 2 } as const;
    const sev = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const list =
      filter === 'action'
        ? f.filter((x) => x.state === 'open' && x.status !== 'pass')
        : filter === 'pass'
          ? f.filter((x) => x.status === 'pass')
          : filter === 'closed'
            ? f.filter((x) => x.state !== 'open' && x.status !== 'pass')
            : f;
    return [...list].sort((a, b) => order[a.status] - order[b.status] || sev[a.severity] - sev[b.severity]);
  }, [ctx, filter]);

  if (!ctx) {
    return error ? (
      <div role="alert" className="fm-banner fm-banner--error">
        {error}
      </div>
    ) : (
      <p className="fm-muted" aria-busy="true">
        Loading code review…
      </p>
    );
  }

  const running = job && (job.state === 'queued' || job.state === 'running');

  return (
    <div className="fm-review">
      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}

      {!ctx.meta || editingMeta ? (
        <MetaForm
          initial={ctx.meta}
          onCancel={ctx.meta ? () => setEditingMeta(false) : undefined}
          onSaved={async () => {
            setEditingMeta(false);
            await load();
          }}
        />
      ) : (
        <p className="fm-meta">
          <strong>{ctx.meta.name}</strong> · {ctx.meta.occupancy.join(', ')} · {ctx.meta.constructionType} · {ctx.meta.stories} stories ·{' '}
          {ctx.meta.areaSqft.toLocaleString()} sq ft · {ctx.meta.sprinklered ? 'sprinklered' : 'not sprinklered'} · {ctx.meta.jurisdiction}{' '}
          <button className="fm-link" onClick={() => setEditingMeta(true)}>
            Edit
          </button>
        </p>
      )}

      {ctx.meta && (
        <section className="fm-card" aria-labelledby="sheets-h">
          <h2 id="sheets-h">Plan sheets</h2>
          {ctx.sheets.length === 0 && <p className="fm-muted">No plan sheets yet. Paste sheet notes or import a PDF attached to this work item.</p>}
          <fieldset className="fm-sheets" disabled={!!running}>
            <legend className="fm-sr">Sheets to review</legend>
            {ctx.sheets.map((s) => (
              <label key={s.sheetId} className="fm-check">
                <input
                  type="checkbox"
                  checked={selected.includes(s.sheetId)}
                  onChange={(e) => setSelected((p) => (e.target.checked ? [...p, s.sheetId] : p.filter((x) => x !== s.sheetId)))}
                />
                <span>
                  <strong>{s.sheetId}</strong> {s.title}
                  <span className="fm-muted">
                    {' '}
                    · {s.discipline ?? 'Any discipline'} · {s.ruleCount ?? '?'} rules{s.suggested ? ' · linked to this item' : ''}
                    {s.source === 'pdf' ? ' · from PDF' : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="fm-actions">
            <button className="fm-btn" onClick={() => startReview()} disabled={!!running || selected.length === 0}>
              {running ? 'Reviewing…' : `Review ${selected.length || ''} sheet${selected.length === 1 ? '' : 's'} against code`}
            </button>
            <button className="fm-btn fm-btn--subtle" onClick={() => setAddingSheet((v) => !v)} disabled={!!running}>
              {addingSheet ? 'Close' : 'Add sheet notes or PDF'}
            </button>
          </div>
          {addingSheet && (
            <AddSheet
              pdfs={ctx.pdfAttachments}
              onPasted={async (id) => {
                setAddingSheet(false);
                await load();
                setSelected((p) => [...new Set([...p, id])]);
              }}
              onPdf={(pdf) => {
                setAddingSheet(false);
                startReview(pdf);
              }}
            />
          )}
          {job && (
            <div className="fm-job" aria-live="polite">
              <div className="fm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
                <div style={{ width: `${Math.max(4, job.progress)}%` }} />
              </div>
              <p className="fm-muted">
                {job.state === 'failed' ? `Review failed: ${job.error}` : job.state === 'done' ? 'Review complete.' : (job.message ?? 'Queued…')}
              </p>
            </div>
          )}
          <p className="fm-fine">
            Rule pack {ctx.rulePack.version} · {ctx.rulePack.total} rules (IBC 2021, 2010 ADA Standards, ACI 318-19). Findings without a verbatim quote
            from the sheet are discarded. Review guidance only; the building official has final authority.
          </p>
        </section>
      )}

      {ctx.findings.length > 0 && (
        <section aria-labelledby="findings-h">
          <div className="fm-findings-head">
            <h2 id="findings-h">Findings</h2>
            <div role="tablist" className="fm-tabs" aria-label="Filter findings">
              {(
                [
                  ['action', `Needs action (${counts.fail + counts.review})`],
                  ['pass', `Passing (${counts.pass})`],
                  ['closed', `Decided (${counts.closed})`],
                  ['all', 'All'],
                ] as [Filter, string][]
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'is-active' : ''} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {visible.length === 0 && <p className="fm-muted">Nothing here.</p>}
          {visible.map((f) => (
            <FindingCard key={f.id} f={f} busy={busyId === f.id} onAct={(a, note) => act(f, a, note)} />
          ))}
        </section>
      )}

      {audit.length > 0 && (
        <details className="fm-details">
          <summary>Audit trail for {ctx.issueKey}</summary>
          <ul className="fm-audit">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="fm-muted">{new Date(a.ts).toLocaleString()}</span> · {a.actorKind} · {a.action}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FindingCard({ f, busy, onAct }: { f: Finding; busy: boolean; onAct: (a: 'create_issue' | 'dismiss' | 'approve' | 'reopen', note?: string) => void }) {
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  return (
    <article className={`fm-finding fm-finding--${f.status}`} aria-label={`${STATUS_LABEL[f.status]}: ${f.ruleId} ${f.title}`}>
      <header>
        <span className={`fm-badge fm-badge--${f.status}`}>{STATUS_LABEL[f.status]}</span>
        <span className={`fm-sev fm-sev--${f.severity}`}>{f.severity}</span>
        <strong>{f.title}</strong>
      </header>
      <p className="fm-cite">
        {f.ruleId} · {f.citation} · sheet {f.sheetId} · {Math.round(f.confidence * 100)}% confidence
      </p>
      <blockquote className="fm-quote">“{f.evidenceQuote}”</blockquote>
      {f.reasoning && <p className="fm-reason">{f.reasoning}</p>}
      {f.suggestedFix && (
        <p className="fm-fix">
          <strong>Suggested fix:</strong> {f.suggestedFix}
        </p>
      )}
      {f.state === 'open' && f.status !== 'pass' && !dismissing && (
        <div className="fm-actions">
          <button className="fm-btn" disabled={busy} onClick={() => onAct('create_issue')}>
            Create Jira issue
          </button>
          <button className="fm-btn fm-btn--subtle" disabled={busy} onClick={() => onAct('approve')}>
            Approve
          </button>
          <button className="fm-btn fm-btn--subtle" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss
          </button>
        </div>
      )}
      {dismissing && (
        <div className="fm-actions">
          <label className="fm-sr" htmlFor={`dn-${f.id}`}>
            Reason for dismissing
          </label>
          <input id={`dn-${f.id}`} className="fm-input" placeholder="Reason (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <button
            className="fm-btn"
            disabled={busy}
            onClick={() => {
              setDismissing(false);
              onAct('dismiss', note || undefined);
            }}
          >
            Dismiss finding
          </button>
          <button className="fm-btn fm-btn--subtle" onClick={() => setDismissing(false)}>
            Cancel
          </button>
        </div>
      )}
      {f.state !== 'open' && (
        <p className="fm-decision">
          {STATE_LABEL[f.state]}
          {f.createdIssueKey && (
            <>
              {' as '}
              <button className="fm-link" onClick={() => router.open(`/browse/${f.createdIssueKey}`)}>
                {f.createdIssueKey}
              </button>
            </>
          )}
          {f.decisionNote ? ` — ${f.decisionNote}` : ''}
          {f.state !== 'ticketed' && (
            <>
              {' · '}
              <button className="fm-link" disabled={busy} onClick={() => onAct('reopen')}>
                Reopen
              </button>
            </>
          )}
        </p>
      )}
    </article>
  );
}

function MetaForm({ initial, onSaved, onCancel }: { initial: Meta | null; onSaved: () => void; onCancel?: () => void }) {
  const [m, setM] = useState<Meta>(
    initial ?? { name: '', occupancy: ['R-2'], constructionType: 'Type V-A', stories: 4, areaSqft: 40000, jurisdiction: '', sprinklered: true },
  );
  const [occ, setOcc] = useState(m.occupancy.join(', '));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await call('saveProjectMeta', { meta: { ...m, occupancy: occ.split(',').map((s) => s.trim()).filter(Boolean) } });
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };
  return (
    <section className="fm-card" aria-labelledby="meta-h">
      <h2 id="meta-h">Project details for code review</h2>
      <p className="fm-muted">Rules are selected from these facts.</p>
      <div className="fm-grid">
        <label>
          Project name
          <input className="fm-input" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />
        </label>
        <label>
          Occupancy groups (comma separated)
          <input className="fm-input" value={occ} onChange={(e) => setOcc(e.target.value)} placeholder="M, R-2" />
        </label>
        <label>
          Construction type
          <input className="fm-input" value={m.constructionType} onChange={(e) => setM({ ...m, constructionType: e.target.value })} />
        </label>
        <label>
          Stories
          <input className="fm-input" type="number" min={1} value={m.stories} onChange={(e) => setM({ ...m, stories: Number(e.target.value) })} />
        </label>
        <label>
          Area (sq ft)
          <input className="fm-input" type="number" min={1} value={m.areaSqft} onChange={(e) => setM({ ...m, areaSqft: Number(e.target.value) })} />
        </label>
        <label>
          Jurisdiction
          <input className="fm-input" value={m.jurisdiction} onChange={(e) => setM({ ...m, jurisdiction: e.target.value })} />
        </label>
        <label className="fm-check">
          <input type="checkbox" checked={m.sprinklered} onChange={(e) => setM({ ...m, sprinklered: e.target.checked })} /> Fully sprinklered (NFPA 13)
        </label>
      </div>
      {err && (
        <div role="alert" className="fm-banner fm-banner--error">
          {err}
        </div>
      )}
      <div className="fm-actions">
        <button className="fm-btn" onClick={save} disabled={!m.name || !m.jurisdiction}>
          Save project details
        </button>
        {onCancel && (
          <button className="fm-btn fm-btn--subtle" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

function AddSheet({
  pdfs,
  onPasted,
  onPdf,
}: {
  pdfs: { id: string; filename: string; size: number }[];
  onPasted: (sheetId: string) => void;
  onPdf: (pdf: { attachmentId: string; sheetId: string; title: string; discipline: string | null }) => void;
}) {
  const [sheetId, setSheetId] = useState('');
  const [title, setTitle] = useState('');
  const [discipline, setDiscipline] = useState<string>('Architectural');
  const [text, setText] = useState('');
  const [pdf, setPdf] = useState(pdfs[0]?.id ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      await call('savePlanSheet', { sheetId, title, discipline, text });
      onPasted(sheetId);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fm-subcard">
      <div className="fm-grid">
        <label>
          Sheet number
          <input className="fm-input" value={sheetId} onChange={(e) => setSheetId(e.target.value)} placeholder="A-301" maxLength={32} />
        </label>
        <label>
          Sheet title
          <input className="fm-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Level 3 Floor Plan" />
        </label>
        <label>
          Discipline
          <select className="fm-input" value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
            {DISCIPLINES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="fm-block">
        Sheet notes (paste general notes, life safety notes, schedules)
        <textarea className="fm-input" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {err && (
        <div role="alert" className="fm-banner fm-banner--error">
          {err}
        </div>
      )}
      <div className="fm-actions">
        <button className="fm-btn" onClick={save} disabled={saving || !sheetId || !title || text.trim().length < 40}>
          Save pasted sheet
        </button>
        {pdfs.length > 0 && (
          <>
            <label className="fm-sr" htmlFor="pdf-pick">
              PDF attachment
            </label>
            <select id="pdf-pick" className="fm-input fm-input--inline" value={pdf} onChange={(e) => setPdf(e.target.value)}>
              {pdfs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.filename} ({Math.round(p.size / 1024)} KB)
                </option>
              ))}
            </select>
            <button
              className="fm-btn fm-btn--subtle"
              disabled={!sheetId || !title || !pdf}
              onClick={() => onPdf({ attachmentId: pdf, sheetId, title, discipline })}
            >
              Import PDF and review
            </button>
          </>
        )}
      </div>
      {pdfs.length === 0 && <p className="fm-fine">Attach a text-based PDF of the sheet to this work item to import it here.</p>}
    </div>
  );
}
