import { useState } from 'react';
import { router } from '@forge/bridge';
import { EmptyState } from './ui';

export interface HeatmapData {
  trades: string[];
  levels: string[];
  cells: { trade: string; level: string; score: number; count: number; keys: string[] }[];
  max: number;
}

const band = (s: number) => (s >= 60 ? 'high' : s >= 30 ? 'medium' : s > 0 ? 'low' : 'none');
const BAND_LABEL = { high: 'High', medium: 'Medium', low: 'Low', none: 'No risk' } as const;

export function Heatmap({ data, issues }: { data: HeatmapData; issues: Record<string, { summary: string; risk: number }> }) {
  const [sel, setSel] = useState<{ trade: string; level: string } | null>(null);
  if (!data.cells.length) return null;
  const cell = (trade: string, level: string) => data.cells.find((c) => c.trade === trade && c.level === level);
  const selected = sel ? cell(sel.trade, sel.level) : null;
  const hasRisk = data.max > 0;

  return (
    <section className="fm-card" aria-labelledby="hm-h">
      <div className="fm-section-title">
        <h2 id="hm-h">Risk by trade and level</h2>
      </div>
      {!hasRisk ? (
        <EmptyState title="No risk scores yet">Run the monitor to score work items.</EmptyState>
      ) : (
        <>
          <div className="fm-heat-wrap">
            <table className="fm-heat">
              <caption className="fm-sr">Highest risk score of the work items for each trade and building level. Select a cell to list its items.</caption>
              <thead>
                <tr>
                  <th scope="col">Trade</th>
                  {data.levels.map((l) => (
                    <th scope="col" key={l}>
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={t}>
                    <th scope="row">{t}</th>
                    {data.levels.map((l) => {
                      const c = cell(t, l);
                      if (!c) return <td key={l} className="fm-heat-cell fm-heat--empty" />;
                      const b = band(c.score);
                      const isSel = sel?.trade === t && sel.level === l;
                      return (
                        <td key={l} className={`fm-heat-cell fm-heat--${b}${isSel ? ' is-selected' : ''}`}>
                          <button
                            onClick={() => setSel(isSel ? null : { trade: t, level: l })}
                            aria-pressed={isSel}
                            aria-label={`${t}, ${l}: ${BAND_LABEL[b]} risk ${c.score}, ${c.count} item${c.count === 1 ? '' : 's'}`}
                          >
                            <span className="fm-heat-score">{c.score || '·'}</span>
                            <span className="fm-heat-count">{c.count}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="fm-legend" aria-label="Legend">
            {(['high', 'medium', 'low', 'none'] as const).map((b) => (
              <li key={b}>
                <span className={`fm-key fm-heat--${b}`} aria-hidden="true" /> {BAND_LABEL[b]}
                {b === 'high' ? ' (60+)' : b === 'medium' ? ' (30–59)' : b === 'low' ? ' (1–29)' : ''}
              </li>
            ))}
            <li className="fm-muted">Large number: highest risk · small number: items</li>
          </ul>
          {selected && (
            <div className="fm-subcard" aria-live="polite">
              <strong>
                {selected.trade} · {selected.level}
              </strong>
              <ul className="fm-ctx-list fm-mt-s">
                {[...selected.keys]
                  .sort((a, b) => (issues[b]?.risk ?? 0) - (issues[a]?.risk ?? 0))
                  .map((k) => (
                    <li key={k}>
                      <button className="fm-link" onClick={() => router.open(`/browse/${k}`)}>
                        {k}
                      </button>{' '}
                      {issues[k]?.summary} <span className="fm-muted">· risk {issues[k]?.risk ?? 0}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
