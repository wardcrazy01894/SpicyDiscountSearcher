import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// A second IIFE build, for the same reason the probe has one: MV3 content
// scripts are classic scripts, not modules. Lib mode emits a single entry per
// build and IIFE cannot carry two, so this is a separate config rather than
// another entry in vite.content.config.ts.
//
// `output.strict` is pinned here for the same reason it is pinned there —
// vite 8 swapped Rollup for Rolldown and defaults it to 'auto', which honours a
// source directive and adds none of its own, silently shipping a sloppy-mode
// content script.
export default defineConfig({
  build: {
    rollupOptions: { output: { strict: true } },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/reset-widget-state.ts'),
      name: 'SpicyResetWidgetState',
      formats: ['iife'],
      fileName: () => 'reset-widget-state.js',
    },
  },
});
