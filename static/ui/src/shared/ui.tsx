import { KeyboardEvent, ReactNode, useId, useRef } from 'react';

/** Small accessible building blocks shared by every Foreman screen (Atlassian design tokens via CSS vars). */

export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="fm-skeleton" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="fm-skeleton-line" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="fm-banner fm-banner--error fm-error">
      <span>
        <strong>Something went wrong.</strong> {friendly(message)}
      </span>
      {onRetry && (
        <button className="fm-btn fm-btn--subtle" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Turn platform error strings into something a site admin can act on. */
export function friendly(message: string): string {
  if (/NEEDS_AUTHENTICATION|consent/i.test(message)) return 'Foreman needs your permission. Reload the page and choose "Allow access".';
  if (/rate|429/i.test(message)) return 'Jira is busy right now. Wait a few seconds and try again.';
  if (/timed? ?out/i.test(message)) return 'This took too long. Try again; long jobs continue in the background.';
  return message.replace(/^Error:\s*/, '').slice(0, 300);
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fm-empty">
      <p className="fm-empty-title">{title}</p>
      {children && <div className="fm-muted">{children}</div>}
      {action && <div className="fm-actions">{action}</div>}
    </div>
  );
}

export function Lozenge({ tone, children }: { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'discovery'; children: ReactNode }) {
  return <span className={`fm-lozenge fm-lozenge--${tone}`}>{children}</span>;
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/** WAI-ARIA tabs with arrow-key navigation. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const onKey = (e: KeyboardEvent, idx: number) => {
    const n = tabs.length;
    const next = e.key === 'ArrowRight' ? (idx + 1) % n : e.key === 'ArrowLeft' ? (idx - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="fm-tabs fm-tabs--main">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          id={`${base}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${base}-panel`}
          tabIndex={value === t.id ? 0 : -1}
          className={value === t.id ? 'is-active' : ''}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="fm-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ id, children, extra }: { id: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="fm-section-title">
      <h2 id={id}>{children}</h2>
      {extra}
    </div>
  );
}

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
export const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
