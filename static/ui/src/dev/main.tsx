import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandCenter } from '@shared/CommandCenter';
import { CodeReview } from '@shared/CodeReview';
import { EvidenceReport } from '@shared/EvidenceReport';
import { GraphContext } from '@shared/GraphContext';
import { Tabs } from '@shared/ui';
import '@shared/base.css';

/** Local preview of every Foreman screen with fixture data (mock bridge). */
function Preview() {
  const [hash, setHash] = useState(location.hash.replace('#', '') || 'cc');
  const [tab, setTab] = useState<'evidence' | 'code' | 'context'>('evidence');
  useEffect(() => {
    const on = () => setHash(location.hash.replace('#', '') || 'cc');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const panel = hash.startsWith('panel');
  return (
    <main key={hash} className={panel ? 'fm-page fm-page--panel fm-preview-panel' : 'fm-page'}>
      {panel ? (
        <>
          <Tabs label="Foreman views" value={tab} onChange={setTab} tabs={[{ id: 'evidence', label: 'Field evidence & report' }, { id: 'code', label: 'Code review' }, { id: 'context', label: 'Context' }]} />
          <div role="tabpanel" className="fm-tabpanel">{tab === 'evidence' ? <EvidenceReport /> : tab === 'context' ? <GraphContext /> : <CodeReview />}</div>
        </>
      ) : (
        <CommandCenter />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
