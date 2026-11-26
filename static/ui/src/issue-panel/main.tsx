import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { CodeReview } from '@shared/CodeReview';
import { EvidenceReport } from '@shared/EvidenceReport';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

type Tab = 'evidence' | 'code';

function Panel() {
  const [tab, setTab] = useState<Tab | null>(null);
  useEffect(() => {
    // Inspections open on field evidence; everything else on code review.
    view
      .getContext()
      .then((c) => {
        const type = (c as { extension?: { issue?: { type?: string } } }).extension?.issue?.type;
        setTab(type === 'Inspection' ? 'evidence' : 'code');
      })
      .catch(() => setTab('code'));
  }, []);
  if (!tab) return null;
  return (
    <main className="fm-page fm-page--panel">
      <div role="tablist" className="fm-tabs fm-tabs--main" aria-label="Foreman views">
        <button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'is-active' : ''} onClick={() => setTab('evidence')}>
          Field evidence &amp; report
        </button>
        <button role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'is-active' : ''} onClick={() => setTab('code')}>
          Code review
        </button>
      </div>
      <div role="tabpanel">{tab === 'evidence' ? <EvidenceReport /> : <CodeReview />}</div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
