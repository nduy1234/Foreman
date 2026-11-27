import { useMemo, useState } from 'react';
import { router } from '@forge/bridge';
import { fmtDate } from './ui';

export interface TimelineRow {
  key: string;
  kind: 'Permit' | 'Inspection';
  summary: string;
  stage: string | null;
  start?: string;
  end?: string;
  date?: string;
  scheduled?: string | null;
  estimated: boolean;
  critical: boolean;
  state: 'done' | 'on_track' | 'at_risk' | 'blocked' | 'unscheduled';
  note: string;
}
export interface TimelineData {
  start: string;
  end: string;
  today: string;
  rows: TimelineRow[];
  links: { from: string; to: string; violated: boolean }[];
  criticalPath: string[];
  forecastFinish: string | null;
  slipDays: number;
  why: string;
}

const DAY = 86_400_000;
const LABEL_W = 280;
const W = 920;
const ROW_H = 30;
const TOP = 34;

const STATE_LABEL: Record<TimelineRow['state'], string> = {
  done: 'Done',
  on_track: 'On track',
  at_risk: 'At risk',
  blocked: 'Blocked',
  unscheduled: 'Not scheduled',
};

export function Timeline({ data }: { data: TimelineData }) {
  const [asTable, setAsTable] = useState(false);
  const t0 = Date.parse(data.start);
  const span = Math.max(1, (Date.parse(data.end) - t0) / DAY);
  const xRaw = (iso: string) => LABEL_W + ((Date.parse(iso) - t0) / DAY / span) * (W - LABEL_W - 16);
  const x = (iso: string) => Math.min(W - 10, Math.max(LABEL_W, xRaw(iso)));
  const rows = data.rows;
  const H = TOP + rows.length * ROW_H + 12;
  const yOf = useMemo(() => new Map(rows.map((r, i) => [r.key, TOP + i * ROW_H + ROW_H / 2])), [rows]);

  // Ticks: weekly, fortnightly or monthly depending on the span, never closer than ~56px.
  const step = span <= 70 ? 7 : span <= 140 ? 14 : 30;
  const ticks: { x: number; label: string }[] = [];
  for (let d = new Date(t0); d.getTime() <= Date.parse(data.end); d = new Date(d.getTime() + step * DAY)) {
    const tx = x(d.toISOString());
    if (ticks.length && tx - ticks[ticks.length - 1].x < 56) continue;
    ticks.push({ x: tx, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
  }

  return (
    <section className="fm-card" aria-labelledby="tl-h">
      <div className="fm-section-title">
        <h2 id="tl-h">Permit and inspection timeline</h2>
        <button className="fm-btn fm-btn--subtle" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      <p className="fm-lede">{data.why}</p>

      {asTable ? (
        <table className="fm-table">
          <caption className="fm-sr">Permits and inspections with forecast dates</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Stage</th>
              <th scope="col">Planned</th>
              <th scope="col">Forecast</th>
              <th scope="col">Status</th>
              <th scope="col">Critical path</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <button className="fm-link" onClick={() => router.open(`/browse/${r.key}`)}>
                    {r.key}
                  </button>{' '}
                  {r.summary}
                </td>
                <td>{r.stage}</td>
                <td>{r.kind === 'Permit' ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : fmtDate(r.scheduled)}</td>
                <td>{r.kind === 'Inspection' ? fmtDate(r.date) : '—'}</td>
                <td>{STATE_LABEL[r.state]}</td>
                <td>{r.critical ? 'Yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="fm-timeline-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} className="fm-timeline" role="img" aria-label={`Timeline. ${data.why}`}>
            <defs>
              <marker id="fm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="fm-tl-arrowhead" />
              </marker>
              <marker id="fm-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="fm-tl-arrowhead--bad" />
              </marker>
            </defs>
            {ticks.map((tk, i) => (
              <g key={i}>
                <line x1={tk.x} x2={tk.x} y1={TOP - 8} y2={H - 6} className="fm-tl-grid" />
                <text x={tk.x + 3} y={14} className="fm-tl-tick">
                  {tk.label}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const y = TOP + i * ROW_H;
              return (
                <g key={r.key}>
                  {i % 2 === 0 && <rect x={0} y={y} width={W} height={ROW_H} className="fm-tl-band" />}
                  <text x={8} y={y + ROW_H / 2 + 4} className={`fm-tl-label${r.critical ? ' is-critical' : ''}`}>
                    <tspan className="fm-tl-key">{r.key}</tspan> {r.summary.length > 34 ? `${r.summary.slice(0, 33)}…` : r.summary}
                  </text>
                </g>
              );
            })}
            {data.links.map((l, i) => {
              const a = rows.find((r) => r.key === l.from);
              const b = rows.find((r) => r.key === l.to);
              if (!a?.date || !b?.date) return null;
              const x1 = x(a.date) + 7;
              const y1 = yOf.get(a.key)!;
              const x2 = x(b.date) - 8;
              const y2 = yOf.get(b.key)!;
              const midX = Math.max(x1 + 6, (x1 + x2) / 2);
              return (
                <path
                  key={i}
                  d={`M${x1},${y1} H${midX} V${y2} H${x2}`}
                  className={l.violated ? 'fm-tl-link fm-tl-link--bad' : 'fm-tl-link'}
                  markerEnd={l.violated ? 'url(#fm-arrow-bad)' : 'url(#fm-arrow)'}
                >
                  <title>{l.violated ? `${l.to} is scheduled before ${l.from} can pass` : `${l.from} must pass before ${l.to}`}</title>
                </path>
              );
            })}
            {rows.map((r) => {
              const cy = yOf.get(r.key)!;
              if (r.kind === 'Permit' && r.start && r.end) {
                const x1 = x(r.start);
                const x2 = Math.max(x1 + 6, x(r.end));
                const clipped = xRaw(r.end) > W - 10;
                return (
                  <g key={r.key} className={`fm-tl-bar fm-tl--${r.state}${r.critical ? ' is-critical' : ''}${r.estimated ? ' is-estimated' : ''}`}>
                    <rect x={x1} y={cy - 7} width={x2 - x1} height={14} rx={3} />
                    {clipped && (
                      <text x={W - 14} y={cy + 4} textAnchor="end" className="fm-tl-clip">
                        ▸ {fmtDate(r.end)}
                      </text>
                    )}
                    <title>{`${r.key} ${r.summary}: ${r.note}`}</title>
                  </g>
                );
              }
              if (!r.date) return null;
              const cx = x(r.date);
              const sx = r.scheduled && r.scheduled !== r.date ? x(r.scheduled) : null;
              return (
                <g key={r.key} className={`fm-tl-ms fm-tl--${r.state}${r.critical ? ' is-critical' : ''}${r.estimated ? ' is-estimated' : ''}`}>
                  {sx !== null && <line x1={sx} x2={cx - 8} y1={cy} y2={cy} className="fm-tl-slip" />}
                  {sx !== null && <circle cx={sx} cy={cy} r={3.5} className="fm-tl-planned" />}
                  <path d={`M${cx},${cy - 8} L${cx + 8},${cy} L${cx},${cy + 8} L${cx - 8},${cy} Z`} />
                  <title>{`${r.key} ${r.summary}: ${STATE_LABEL[r.state]}. ${r.note}`}</title>
                </g>
              );
            })}
            <line x1={x(data.today)} x2={x(data.today)} y1={TOP - 14} y2={H - 4} className="fm-tl-today" />
            <text x={x(data.today) + 4} y={TOP - 4} className="fm-tl-today-label">
              Today
            </text>
          </svg>
          <ul className="fm-legend" aria-label="Legend">
            <li>
              <span className="fm-key fm-key--critical" aria-hidden="true" /> Critical path
            </li>
            <li>
              <span className="fm-key fm-key--done" aria-hidden="true" /> Done
            </li>
            <li>
              <span className="fm-key fm-key--at_risk" aria-hidden="true" /> At risk
            </li>
            <li>
              <span className="fm-key fm-key--blocked" aria-hidden="true" /> Blocked
            </li>
            <li>
              <span className="fm-key fm-key--estimated" aria-hidden="true" /> Forecast (dashed)
            </li>
            <li>
              <span className="fm-key fm-key--bad-link" aria-hidden="true" /> Out of sequence
            </li>
          </ul>
        </div>
      )}
      {data.forecastFinish && (
        <p className="fm-fine">
          Forecast assumes a {2}-day buffer after each prerequisite inspection and a typical {21}-day permit review. Planned dates come from Jira.
        </p>
      )}
    </section>
  );
}
