import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { Diagnostics } from '@shared/Diagnostics';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Diagnostics title="Foreman Command Center" subtitle="Permits, inspections, risks and approvals for this project." />
  </React.StrictMode>,
);
