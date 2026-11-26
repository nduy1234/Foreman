import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { call, Status } from '@shared/api';
import { DemoLoader } from '@shared/DemoLoader';
import { Diagnostics } from '@shared/Diagnostics';
import { Monitor } from '@shared/Monitor';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

function CommandCenter() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    call<Status>('getStatus').then(setStatus).catch(() => undefined);
  }, []);
  return (
    <main className="fm-page">
      <header className="fm-header">
        <h1>Foreman Command Center</h1>
        <p className="fm-muted">Permits, inspections, risks and approvals for this project.</p>
      </header>
      <Monitor notMonitored={<DemoLoader currentProjectKey={status?.projectKey ?? null} />} />
      <details className="fm-details">
        <summary>Demo project</summary>
        <DemoLoader currentProjectKey={status?.projectKey ?? null} />
      </details>
      <details className="fm-details">
        <summary>System check</summary>
        <Diagnostics embedded />
      </details>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CommandCenter />
  </React.StrictMode>,
);
