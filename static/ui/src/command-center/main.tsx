import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { CommandCenter } from '@shared/CommandCenter';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="fm-page">
      <CommandCenter />
    </main>
  </React.StrictMode>,
);
