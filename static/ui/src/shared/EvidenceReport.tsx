import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestJira, router } from '@forge/bridge';
import { call, Job, waitForJob } from './api';
import { EmptyState, ErrorState, fmtDate, Skeleton } from './ui';

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

type LineStatus = 'verified' | 'needs_review' | 'conflict';

interface EvidenceRef {
  type: 'observation' | 'photo' | 'plan' | 'permit' | 'prior_inspection' | 'finding';
  label: string;
  quote?: string;
  evidenceId?: string;
  capturedAt?: string | null;
  issueKey?: string;
  sheetId?: string;
}
interface ReportLine {
  id: string;
  kind: 'checklist' | 'permit_condition' | 'permit' | 'prior_inspection' | 'photo';
  item: string;
  status: LineStatus;
  rationale: string;
  evidence: EvidenceRef[];
}
interface Report {
  id: number;
  version: number;
  state: 'draft' | 'awaiting_signoff' | 'approved' | 'changes_requested';
  confluenceUrl: string | null;
  signedAt: string | null;
  signoffNote: string | null;
  report: {
    inspectionDate: string;
    lines: ReportLine[];
    counts: Record<LineStatus, number>;
    recommendation: 'ready_for_signoff' | 'needs_review' | 'conflicts_found';
    summary: string;
    dropped: { what: string; reason: string }[];
    observations: { id: string; quote: string; topic: string }[];
  };
}
interface EvidenceCtx {
  issueKey: string;
  stage: string | null;
  kind: string | null;
  checklistCount: number;
  notes: { id: string; kind: 'note' | 'transcript'; author: string | null; capturedAt: string | null; excerpt: string }[];
  photos: { id: string; filename: string; size: number; created: string }[];
  report: Report | null;
  job: Job | null;
}

const STATUS: Record<LineStatus, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'ok' },
  needs_review: { label: 'Needs review', cls: 'warn' },
  conflict: { label: 'Conflict', cls: 'bad' },
};
const KIND_LABEL: Record<ReportLine['kind'], string> = {
  checklist: 'Checklist',
  permit_condition: 'Permit condition',
  permit: 'Permit',
  prior_inspection: 'Prior inspection',
  photo: 'Photo',
};
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'time unknown');

/** Loads an attachment thumbnail through the bridge (auth stays in Jira) and shows it as a data URL. */
function Thumb({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    requestJira(`/rest/api/3/attachment/thumbnail/${id}?redirect=false&fallbackToDefault=true&width=240&height=180`)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (b) =>
          b &&
          new Promise<string>((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.readAsDataURL(b);
          }),
      )
      .then((d) => alive && d && setSrc(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? <img className="fm-thumb" src={src} alt={alt} /> : <div className="fm-thumb fm-thumb--empty" aria-label={alt} />;
}

export function EvidenceReport() {
  const [ctx, setCtx] = useState<EvidenceCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [adding, setAdding] = useState<null | 'note' | 'transcript'>(null);

  const load = useCallback(async () => {
    try {
      const c = await call<EvidenceCtx>('getEvidenceContext');
      setCtx(c);
      if (c.job && (c.job.state === 'queued' || c.job.state === 'running')) setJob(c.job);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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

  const generate = async () => {
    setError(null);
    try {
      const { jobId } = await call<{ jobId: number }>('startEvidenceReport');
      setJob({ id: jobId, kind: 'evidence_report', state: 'queued', progress: 0, message: 'Queued', result: null, error: null });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  if (!ctx) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={5} label="Loading field evidence" />;

  const running = !!job && (job.state === 'queued' || job.state === 'running');
  const r = ctx.report;

  return (
    <div className="fm-review">
      {error && (
        <div role="alert" className="fm-banner fm-banner--error">
          {error}
        </div>
      )}
      {ctx.kind && ctx.kind !== 'Inspection' && (
        <p className="fm-banner fm-banner--info">Field reports are designed for Inspection work items; this is a {ctx.kind}.</p>
      )}

      <section className="fm-card" aria-labelledby="ev-h">
        <h2 id="ev-h">Field evidence</h2>
        <p className="fm-muted">
          {n(ctx.notes.filter((x) => x.kind === 'note').length, 'field note')} · {n(ctx.notes.filter((x) => x.kind === 'transcript').length, 'voice transcript')} ·{' '}
          {n(ctx.photos.length, 'photo')} · {n(ctx.checklistCount, 'checklist item')} · stage <strong>{ctx.stage ?? 'unknown'}</strong>
        </p>
        {ctx.photos.length > 0 && (
          <div className="fm-photos">
            {ctx.photos.map((p) => (
              <figure key={p.id}>
                <Thumb id={p.id} alt={p.filename} />
                <figcaption>{p.filename}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {ctx.notes.length === 0 && ctx.photos.length === 0 && (
          <EmptyState title="No field evidence yet">
            Add a field note or voice-note transcript below, or attach site photos to this work item. Foreman links each one to the checklist.
          </EmptyState>
        )}
        {ctx.notes.length > 0 && (
          <ul className="fm-notes">
            {ctx.notes.map((n) => (
              <li key={n.id}>
                <span className={`fm-chip fm-chip--${n.kind}`}>{n.kind === 'transcript' ? 'Voice' : 'Note'}</span> <strong>{n.author ?? 'Unknown'}</strong>{' '}
                <span className="fm-muted">{fmt(n.capturedAt)}</span>
                <div className="fm-excerpt">{n.excerpt}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="fm-actions">
          <button className="fm-btn" onClick={generate} disabled={running}>
            {running ? 'Building report…' : r ? 'Regenerate verified report' : 'Generate verified report'}
          </button>
          <button className="fm-btn fm-btn--subtle" onClick={() => setAdding('note')} disabled={running}>
            Add field note
          </button>
          <button className="fm-btn fm-btn--subtle" onClick={() => setAdding('transcript')} disabled={running}>
            Add voice transcript
          </button>
        </div>
        {adding && (
          <AddNote
            kind={adding}
            onDone={async () => {
              setAdding(null);
              await load();
            }}
            onCancel={() => setAdding(null)}
          />
        )}
        {job && job.state !== 'done' && (
          <div className="fm-job" aria-live="polite">
            <div className="fm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
              <div style={{ width: `${Math.max(4, job.progress)}%` }} />
            </div>
            <p className="fm-muted">{job.state === 'failed' ? `Report failed: ${job.error}` : (job.message ?? 'Queued…')}</p>
          </div>
        )}
        <p className="fm-fine">
          Photos contribute capture time and location (EXIF) and corroborate notes; Forge-hosted models do not read image content. Every quote is
          checked against its source note or plan sheet.
        </p>
      </section>

      {r && (
        <>
          <Breakdown report={r} />
          <SplitView report={r} photos={ctx.photos} />
          <SignOff report={r} onChanged={load} onError={setError} />
        </>
      )}
    </div>
  );
}

function Breakdown({ report }: { report: Report }) {
  const { counts, recommendation, summary } = report.report;
  const total = counts.verified + counts.needs_review + counts.conflict || 1;
  const rec =
    recommendation === 'conflicts_found'
      ? { cls: 'bad', text: 'Conflicts found — resolve or acknowledge before sign-off' }
      : recommendation === 'needs_review'
        ? { cls: 'warn', text: 'Needs review — some items lack evidence' }
        : { cls: 'ok', text: 'Ready for inspector sign-off' };
  return (
    <section className="fm-card" aria-labelledby="bd-h">
      <div className="fm-findings-head">
        <h2 id="bd-h">
          Report v{report.version} · inspection {fmtDate(report.report.inspectionDate)}
        </h2>
        <span className={`fm-pill fm-pill--${rec.cls}`}>{rec.text}</span>
      </div>
      <div
        className="fm-stack"
        role="img"
        aria-label={`${counts.verified} verified, ${counts.needs_review} need review, ${counts.conflict} conflicts out of ${total} lines`}
      >
        {(['verified', 'needs_review', 'conflict'] as LineStatus[]).map((s) =>
          counts[s] ? (
            <div key={s} className={`fm-stack-seg fm-stack-seg--${STATUS[s].cls}`} style={{ width: `${(counts[s] / total) * 100}%` }}>
              {counts[s]}
            </div>
          ) : null,
        )}
      </div>
      <ul className="fm-legend">
        {(['verified', 'needs_review', 'conflict'] as LineStatus[]).map((s) => (
          <li key={s}>
            <span className={`fm-dot fm-dot--${STATUS[s].cls}`} aria-hidden="true" /> {STATUS[s].label} <strong>{counts[s]}</strong>
          </li>
        ))}
      </ul>
      <p>{summary}</p>
    </section>
  );
}

/**
 * Evidence split view: photos | checklist lines | plan, permit and sequence references.
 * Selecting a line highlights its photos and shows its references; selecting a photo filters the
 * lines that cite it. Every status has a text label, not only a colour.
 */
function SplitView({ report, photos }: { report: Report; photos: EvidenceCtx['photos'] }) {
  const lines = report.report.lines;
  const [lineId, setLineId] = useState<string | null>(() => (lines.find((l) => l.status === 'conflict') ?? lines[0])?.id ?? null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const line = lines.find((l) => l.id === lineId) ?? null;
  const photoIdsOf = (l: ReportLine) => l.evidence.filter((e) => e.type === 'photo' && e.evidenceId).map((e) => e.evidenceId!.replace('photo-', ''));
  const linkedPhotos = new Set(line ? photoIdsOf(line) : []);
  const visibleLines = photoId ? lines.filter((l) => photoIdsOf(l).includes(photoId)) : lines;
  const quotes = line?.evidence.filter((e) => e.type === 'observation') ?? [];
  const refs = line?.evidence.filter((e) => e.type !== 'observation' && e.type !== 'photo') ?? [];
  const photoMeta = (id: string) => line?.evidence.find((e) => e.type === 'photo' && e.evidenceId === `photo-${id}`);

  return (
    <section className="fm-card" aria-labelledby="split-h">
      <div className="fm-section-title">
        <h2 id="split-h">Evidence split view</h2>
        {photoId && (
          <button className="fm-btn fm-btn--subtle" onClick={() => setPhotoId(null)}>
            Show all lines
          </button>
        )}
      </div>
      <div className="fm-split3">
        <div className="fm-split-col" aria-label="Photos">
          <h3>Photos</h3>
          {photos.length === 0 && <p className="fm-muted">No photos attached.</p>}
          <div className="fm-split-photos">
            {photos.map((p) => {
              const linked = linkedPhotos.has(p.id);
              const meta = photoMeta(p.id);
              return (
                <button
                  key={p.id}
                  className={`fm-split-photo${linked ? ' is-linked' : ''}${photoId === p.id ? ' is-selected' : ''}`}
                  aria-pressed={photoId === p.id}
                  onClick={() => setPhotoId(photoId === p.id ? null : p.id)}
                  aria-label={`${p.filename}: show the checklist lines that cite this photo`}
                >
                  <Thumb id={p.id} alt={p.filename} />
                  <span className="fm-split-cap">
                    {p.filename}
                    {linked && <span className="fm-sr"> (linked to the selected line)</span>}
                    {meta?.capturedAt ? <span className="fm-muted"> · EXIF {fmt(meta.capturedAt)}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="fm-split-col" aria-label="Checklist and conditions">
          <h3>Checklist and conditions{photoId ? ' citing this photo' : ''}</h3>
          {visibleLines.length === 0 && <p className="fm-muted">No line cites this photo.</p>}
          <ul className="fm-split-lines">
            {visibleLines.map((l) => (
              <li key={l.id}>
                <button className={`fm-split-line fm-line--${STATUS[l.status].cls}${lineId === l.id ? ' is-selected' : ''}`} aria-pressed={lineId === l.id} onClick={() => setLineId(l.id)}>
                  <span className={`fm-badge fm-badge--${l.status === 'verified' ? 'pass' : l.status === 'conflict' ? 'fail' : 'needs_review'}`}>{STATUS[l.status].label}</span>
                  <span className="fm-split-line-text">
                    <span className="fm-kind">{KIND_LABEL[l.kind]}</span>
                    {l.item}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="fm-split-col" aria-label="Evidence for the selected line" aria-live="polite">
          <h3>Why</h3>
          {!line ? (
            <p className="fm-muted">Select a line.</p>
          ) : (
            <>
              <p className="fm-reason">
                <strong>{STATUS[line.status].label}:</strong> {line.rationale}
              </p>
              {quotes.map((e, i) => (
                <blockquote key={i} className="fm-quote">
                  “{e.quote}”
                  <footer>
                    {e.label} · {fmt(e.capturedAt)}
                  </footer>
                </blockquote>
              ))}
              {refs.map((e, i) => (
                <div key={i} className="fm-ref">
                  <strong>{e.type === 'plan' ? `Plan citation · ${e.sheetId}` : e.label}</strong>
                  {e.quote && <blockquote className={`fm-quote${e.type === 'plan' ? ' fm-quote--plan' : ''}`}>“{e.quote}”</blockquote>}
                  {e.issueKey && (
                    <button className="fm-link" onClick={() => router.open(`/browse/${e.issueKey}`)}>
                      Open {e.issueKey}
                    </button>
                  )}
                </div>
              ))}
              {!quotes.length && !refs.length && !linkedPhotos.size && <p className="fm-muted">No evidence linked yet. Add a field note or photo, then regenerate.</p>}
            </>
          )}
        </div>
      </div>
      {report.report.dropped.length > 0 && (
        <p className="fm-fine">
          {report.report.dropped.length} unsupported link(s) were discarded because the quote was not found in its source.
        </p>
      )}
    </section>
  );
}

function SignOff({ report, onChanged, onError }: { report: Report; onChanged: () => void; onError: (e: string | null) => void }) {
  const [spaces, setSpaces] = useState<{ id: string; key: string; name: string }[] | null>(null);
  const [confluenceError, setConfluenceError] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const conflicts = report.report.counts.conflict;

  useEffect(() => {
    if (report.state !== 'draft' && report.state !== 'changes_requested') return;
    call<{ ok: boolean; spaces?: { id: string; key: string; name: string }[]; error?: string }>('listConfluenceSpaces')
      .then((r) => (r.ok ? setSpaces(r.spaces ?? []) : setConfluenceError(r.error ?? 'Confluence unavailable')))
      .catch(() => setConfluenceError('Confluence unavailable'));
  }, [report.state]);

  const run = async (fn: string, payload: Record<string, unknown>) => {
    setBusy(true);
    onError(null);
    try {
      const r = await call<{ ok: boolean; error?: string }>(fn, payload);
      if (!r.ok) onError(r.error ?? 'Failed');
      else {
        setNote('');
        setAck(false);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const frmn = useMemo(() => spaces?.find((s) => s.key === 'FRMN'), [spaces]);

  if (report.state === 'approved') {
    return (
      <section className="fm-card fm-card--ok" aria-live="polite">
        <h2>Signed off — inspection Passed</h2>
        <p>
          Approved {report.signedAt ? fmt(report.signedAt) : ''}.{report.signoffNote ? ` Note: ${report.signoffNote}` : ''}
        </p>
        {report.confluenceUrl && (
          <button className="fm-link" onClick={() => router.open(report.confluenceUrl!)}>
            Open Confluence report
          </button>
        )}
      </section>
    );
  }

  if (report.state === 'draft' || report.state === 'changes_requested') {
    return (
      <section className="fm-card" aria-labelledby="pub-h">
        <h2 id="pub-h">Publish and request sign-off</h2>
        {report.state === 'changes_requested' && <p className="fm-banner fm-banner--warn">Changes were requested: {report.signoffNote}. Regenerate the report after updating evidence.</p>}
        <p className="fm-muted">Publishing moves the inspection to Awaiting Sign-off. It never marks the inspection Passed.</p>
        {spaces && (
          <label className="fm-block">
            Confluence space
            <select className="fm-input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              <option value="">{frmn ? `${frmn.name} (FRMN)` : 'Create "Foreman Inspection Reports" (FRMN)'}</option>
              {spaces
                .filter((s) => s.key !== 'FRMN')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.key})
                  </option>
                ))}
            </select>
          </label>
        )}
        {confluenceError && <p className="fm-muted">{confluenceError}</p>}
        <div className="fm-actions">
          {!confluenceError && (
            <button className="fm-btn" disabled={busy || !spaces} onClick={() => run('publishReport', { reportId: report.id, spaceId: spaceId || frmn?.id || null })}>
              Publish to Confluence and request sign-off
            </button>
          )}
          <button className="fm-btn fm-btn--subtle" disabled={busy} onClick={() => run('publishReport', { reportId: report.id, skipConfluence: true })}>
            Request sign-off in Jira only
          </button>
        </div>
      </section>
    );
  }

  // awaiting_signoff
  return (
    <section className="fm-card fm-card--signoff" aria-labelledby="so-h">
      <h2 id="so-h">Inspector sign-off</h2>
      <p>
        Report v{report.version} is awaiting the inspector's decision.{' '}
        {report.confluenceUrl && (
          <button className="fm-link" onClick={() => router.open(report.confluenceUrl!)}>
            Open Confluence report
          </button>
        )}
      </p>
      <label className="fm-block">
        Note {conflicts > 0 ? '(required to approve with conflicts)' : '(required to request changes)'}
        <textarea className="fm-input" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {conflicts > 0 && (
        <label className="fm-check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            I have reviewed the {conflicts} conflict{conflicts === 1 ? '' : 's'} and accept responsibility for approving anyway.
          </span>
        </label>
      )}
      <div className="fm-actions">
        <button
          className="fm-btn fm-btn--approve"
          disabled={busy || (conflicts > 0 && (!ack || !note.trim()))}
          onClick={() => run('signOffReport', { reportId: report.id, decision: 'approve', note: note || undefined, acknowledgeConflicts: ack })}
        >
          Approve — mark inspection Passed
        </button>
        <button
          className="fm-btn fm-btn--subtle"
          disabled={busy || !note.trim()}
          onClick={() => run('signOffReport', { reportId: report.id, decision: 'request_changes', note })}
        >
          Request changes
        </button>
      </div>
    </section>
  );
}

function AddNote({ kind, onDone, onCancel }: { kind: 'note' | 'transcript'; onDone: () => void; onCancel: () => void }) {
  const [author, setAuthor] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call('addFieldNote', { kind, author: author || undefined, text });
      onDone();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fm-subcard">
      <label className="fm-block">
        {kind === 'transcript' ? 'Speaker' : 'Author'} (optional, defaults to you)
        <input className="fm-input" value={author} maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <label className="fm-block">
        {kind === 'transcript' ? 'Paste the voice-note transcript' : 'What did you observe? Include grid lines, levels, sizes.'}
        <textarea className="fm-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {err && (
        <div role="alert" className="fm-banner fm-banner--error">
          {err}
        </div>
      )}
      <div className="fm-actions">
        <button className="fm-btn" disabled={busy || text.trim().length < 10} onClick={save}>
          Add to work item
        </button>
        <button className="fm-btn fm-btn--subtle" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
