#!/usr/bin/env node
/**
 * Verify dist/ is a loadable unpacked extension.
 *
 * Chrome accepts a manifest that references a missing script and then just
 * fails quietly at runtime, so CI checks every referenced path exists before
 * calling a build good.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  ...(typeof manifest.action?.default_icon === 'string'
    ? [manifest.action.default_icon]
    : Object.values(manifest.action?.default_icon ?? {})),
].filter(Boolean);

// The manifest points at the popup HTML, but the HTML points at the scripts and
// styles that make it a popup rather than a blank page. Those paths are checked
// by nothing else: the manifest pins background.js and content.js by name, and
// says nothing at all about what the popup loads. A build that drops or
// misplaces the popup's own chunk installs fine and opens blank.
const popup = manifest.action?.default_popup;
let fromPopup = 0;
if (popup && existsSync(join(dist, popup))) {
  // Commented-out tags and inline script bodies are not things the build was
  // asked to emit. Temporarily commenting out a <script src> would otherwise
  // fail CI for a file that is deliberately absent — the same wrong-reason
  // failure this checker exists to avoid.
  const html = readFileSync(join(dist, popup), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
  // Only the tags that load something. `href` alone also matches `<a href="#tab">`
  // and `mailto:`, and a bare src/href match picks up `data-src` too — a checker
  // that fails on an in-page anchor is the same sin as one that passes on a
  // missing chunk.
  for (const [, url] of html.matchAll(
    /<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi,
  )) {
    // Anything with a scheme, a protocol-relative host, or an in-page anchor is
    // not a file this build was supposed to emit.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) continue;
    const path = url.split(/[?#]/)[0];
    if (!path) continue;
    // Absolute paths are relative to dist/, which is the extension root.
    referenced.push(path.startsWith('/') ? path.slice(1) : join(dirname(popup), path));
    fromPopup += 1;
  }
}

const problems = [];
for (const relative of referenced) {
  const absolute = join(dist, relative);
  if (!existsSync(absolute)) problems.push(`${relative} — missing`);
  // A zero-byte chunk installs fine and does nothing, which is the same class
  // of quiet failure as a missing one.
  else if (statSync(absolute).size === 0) problems.push(`${relative} — empty`);
}

// MV3 content scripts are not ES modules; a bundle that ships `import` or
// `export` fails to inject and takes the whole race with it. Nothing else
// checks this — no test imports from dist/ — and vite 8 swapped Rollup for
// Rolldown underneath, so the shape of this file is not something to assume.
const contentScripts = (manifest.content_scripts ?? []).flatMap((script) => script.js ?? []);
for (const relative of contentScripts) {
  const absolute = join(dist, relative);
  if (!existsSync(absolute)) continue;
  const source = readFileSync(absolute, 'utf8');
  if (/^\s*(?:import|export)\s/m.test(source) || /\bexport\s*\{/.test(source)) {
    problems.push(`${relative} — contains module syntax; MV3 content scripts must be classic`);
  }
  if (
    !source.trimStart().startsWith('"use strict"') &&
    !source.trimStart().startsWith("'use strict'")
  ) {
    problems.push(`${relative} — not in strict mode; check the bundler's output.strict`);
  }
}

// A popup that references nothing loads as a blank page, which is the failure
// this script exists for — so silence from the parser is itself a problem.
if (popup && fromPopup === 0) {
  problems.push(`${popup} — references no scripts or styles`);
}

if (problems.length > 0) {
  console.error('dist/ is not loadable:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`dist/ looks loadable: ${referenced.length} referenced files all present.`);
