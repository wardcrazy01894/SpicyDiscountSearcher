import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// MV3 content scripts are injected as classic scripts, not modules, so this
// build emits one self-contained IIFE with no imports and no shared chunks.
export default defineConfig({
  build: {
    // Rolldown (vite 8) defaults output.strict to 'auto' — it honours a
    // "use strict" directive in the source and adds none of its own, where
    // Rollup defaulted to true. The TS source has no directive, so upgrading
    // silently shipped a sloppy-mode content script into every vendor page.
    rollupOptions: { output: { strict: true } },
    outDir: 'dist',
    emptyOutDir: false, // the main build already populated dist/
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/probe.ts'),
      name: 'SpicyProbe',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
