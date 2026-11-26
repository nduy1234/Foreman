import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { CodeReview } from '@shared/CodeReview';
import '@shared/base.css';

view.theme.enable().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="fm-page fm-page--panel">
      <CodeReview />
    </main>
  </React.StrictMode>,
);
