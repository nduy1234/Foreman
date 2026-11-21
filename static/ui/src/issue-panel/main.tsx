import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { Diagnostics } from '@shared/Diagnostics';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Diagnostics title="Evidence & Code Review" subtitle="Code findings, field evidence and inspector sign-off for this work item." />
  </React.StrictMode>,
);
