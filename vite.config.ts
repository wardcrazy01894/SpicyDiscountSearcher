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
    // No `<link rel="modulepreload">` in the built popup.
    //
    // `deeplinks.ts` is imported by both the popup and the service worker, so
    // Vite hoists it into a shared chunk and preloads it from the popup's HTML.
    // Chrome then fetches it twice over: once for the hint and once for the real
    // ES-module import, and — because this is a `chrome-extension://` URL served
    // with `crossorigin` — it cannot match the two, so every popup open logged
    // "cross-world extension resource mismatch" followed by "preloaded ... but
    // not used". Both are Chrome reporting a wasted hint rather than a failure;
    // the chunk always loaded through the import.
    //
    // A preload exists to start a network fetch earlier than the parser would.
    // The popup reads a handful of kilobytes off local disk, so there is no
    // latency here to hide and the hint buys nothing measurable — which makes
    // deleting it strictly better than keeping it and explaining the warnings.
    modulePreload: false,
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
