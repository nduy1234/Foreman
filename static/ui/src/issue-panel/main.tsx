import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { CodeReview } from '@shared/CodeReview';
import { EvidenceReport } from '@shared/EvidenceReport';
import { GraphContext } from '@shared/GraphContext';
import { Skeleton, Tabs } from '@shared/ui';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

type Tab = 'evidence' | 'code' | 'context';

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
  if (!tab) return <Skeleton lines={3} label="Loading Foreman" />;
  return (
    <main className="fm-page fm-page--panel">
      <Tabs<Tab>
        label="Foreman views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'evidence', label: 'Field evidence & report' },
          { id: 'code', label: 'Code review' },
          { id: 'context', label: 'Context' },
        ]}
      />
      <div role="tabpanel" className="fm-tabpanel">
        {tab === 'evidence' ? <EvidenceReport /> : tab === 'context' ? <GraphContext /> : <CodeReview />}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
