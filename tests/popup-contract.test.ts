/**
 * @vitest-environment jsdom
 *
 * The popup's contract with its own HTML.
 *
 * `popup.ts` runs fifteen `el()` lookups at module top level — before the
 * `void main().catch(...)` at the bottom is installed — so a missing id throws
 * during module evaluation and the popup renders as dead HTML stuck on
 * "Loading codes…". Nothing else catches that: renaming one id in index.html
 * leaves typecheck, eslint, vitest, the build and check-dist all green while
 * the extension is completely non-functional, because `check-dist.mjs` verifies
 * that referenced *files* exist and never parses ids.
 *
 * These tests import the real module against the real HTML, so they cover the
 * whole import-time path rather than a hand-copied list of selectors that could
 * itself drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HTML = readFileSync(path.join(ROOT, 'src/popup/index.html'), 'utf8');
const BODY = /<body[^>]*>([\s\S]*)<\/body>/i.exec(HTML)?.[1] ?? '';

/** Every `el('#id')` selector the module resolves at import time. */
const SELECTORS = [
  '#trip-form',
  '#tagline',
  '#car-fields',
  '#hotel-fields',
  '#vendor-chips',
  '#company-search',
  '#company-list',
  '#max-codes',
  '#concurrency',
  '#plan-summary',
  '#run-btn',
  '#cancel-btn',
  '#results',
  '#savings',
  '#quotes',
];

/** The slice of chrome the popup touches while starting up. */
function installChrome(): void {
  const local = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: () => Promise.resolve(Object.fromEntries(local)),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, v);
          return Promise.resolve();
        },
      },
    },
    runtime: {
      sendMessage: () => Promise.resolve({ type: 'RUN_STATE', state: null }),
      onMessage: { addListener: () => {} },
    },
  };
}

beforeEach(() => {
  installChrome();
  document.body.innerHTML = BODY;
});

afterEach(() => {
  vi.resetModules();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('the popup against its own HTML', () => {
  it('imports and starts up without throwing', async () => {
    await expect(import('../src/popup/popup.js')).resolves.toBeDefined();
    // Startup got as far as the tagline. Not "nothing threw": `main()`'s own
    // catch swallows a later failure and writes it into the plan line, so
    // check that line too rather than claiming more than this can see.
    await vi.waitFor(() => {
      expect(document.querySelector('#tagline')?.textContent).toMatch(/corporate codes loaded/);
    });

    // Then wait past everything main() still has to do. Neither of the obvious
    // signals is one: the tagline is written *before* the GET_STATE round trip,
    // and the plan line is populated by `setCategory` before it too — so both
    // appear while main() is still pending, and a failure after them lands
    // later. Checked against either, this assertion was pinned to the chrome
    // stub resolving in a microtask rather than to the popup, and a mutant that
    // threw right after main() survived once the stub was delayed 30 ms.
    //
    // A fixed wait is the honest instrument here, since the thing being waited
    // for is "nothing else is coming" and no DOM state says that. 250 ms is an
    // age for a stub that resolves immediately.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(/Could not start up/);
  });

  it.each(SELECTORS)('finds %s in index.html', (selector) => {
    expect(document.querySelector(selector)).not.toBeNull();
  });

  it('has a selector for every el() call in the module, and no more', () => {
    // Guards the list above against drifting from the source it describes —
    // otherwise this file could keep passing while popup.ts grew a sixteenth
    // lookup nobody checked.
    const source = readFileSync(path.join(ROOT, 'src/popup/popup.ts'), 'utf8');
    const found = [...source.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(SELECTORS));
  });

  it('finds the category tabs the module wires listeners onto', () => {
    // Not an el() lookup, so it fails silently rather than loudly: no tabs
    // means no way to switch between cars and hotels, and no error either.
    expect(document.querySelectorAll('.tab').length).toBeGreaterThan(0);
  });

  it.each(SELECTORS)('fails loudly when %s is missing', async (selector) => {
    // The point of the whole file. Without this, renaming an id ships a dead
    // popup with every required check green.
    const id = selector.slice(1);
    document.body.innerHTML = BODY.replace(`id="${id}"`, `id="${id}-renamed"`);
    await expect(import('../src/popup/popup.js')).rejects.toThrow(/missing element/);
  });
});
