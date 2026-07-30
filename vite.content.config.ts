import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// MV3 content scripts are injected as classic scripts, not modules, so this
// build emits one self-contained IIFE with no imports and no shared chunks.
export default defineConfig({
  build: {
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
