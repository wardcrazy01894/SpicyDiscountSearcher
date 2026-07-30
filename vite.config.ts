import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Main extension build: the popup (an HTML entry) and the MV3 service worker.
// Both are ES modules, which the service worker opts into via
// `"type": "module"` in the manifest.
//
// The content script cannot be built here — MV3 content scripts are not
// modules, so they have to be bundled as a single IIFE. That is
// vite.content.config.ts, run second with `emptyOutDir` off.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/index.html'),
        background: resolve(import.meta.dirname, 'src/background/service-worker.ts'),
      },
      output: {
        // Stable, unhashed names so manifest.json can reference them.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
