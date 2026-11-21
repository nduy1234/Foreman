import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// One codebase, two Custom UI bundles. `--mode` picks the entry; output goes to the
// resource path declared in manifest.yml (static/ui/build/<mode>/index.html).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  // Inline config stops PostCSS from searching parent dirs for stray configs.
  css: { postcss: { plugins: [] } },
  root: resolve(import.meta.dirname, 'src', mode),
  build: {
    outDir: resolve(import.meta.dirname, 'build', mode),
    emptyOutDir: true,
  },
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
}));
