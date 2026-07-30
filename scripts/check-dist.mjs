#!/usr/bin/env node
/**
 * Verify dist/ is a loadable unpacked extension.
 *
 * Chrome accepts a manifest that references a missing script and then just
 * fails quietly at runtime, so CI checks every referenced path exists before
 * calling a build good.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifestPath = join(dist, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error('dist/manifest.json is missing — did `npm run build` run?');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

const missing = referenced.filter((relative) => !existsSync(join(dist, relative)));

if (missing.length > 0) {
  console.error('manifest.json references files the build did not emit:');
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

console.log(`dist/ looks loadable: ${referenced.length} referenced files all present.`);
