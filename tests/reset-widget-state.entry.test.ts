/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.avis.com/" }
 *
 * The part that actually runs.
 *
 * `reset-widget-state.test.ts` covers the exported functions; this covers the
 * top-level call that invokes them, which is the only thing present in the
 * shipped bundle. Deleting that line left the whole suite green — the seam made
 * the module testable and then the test stopped short of the one statement with
 * a side effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const OURS =
  'https://www.avis.com/en/reservation/vehicle-availability?pickup_location_code=TPA&awd_number=D486600';

/**
 * Restored rather than deleted, and in a `finally`-shaped hook, because an own
 * property left on a global is how a previous test in this PR silently turned
 * its neighbour into a false pass.
 */
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

async function importOn(href: string): Promise<string[]> {
  const removed: string[] = [];
  // jsdom forbids assigning `location`, and its origin is fixed for the file by
  // the environment options above — hence the avis.com origin there, with only
  // the path and query moved per case.
  const target = new URL(href);
  window.history.replaceState({}, '', target.pathname + target.search);
  // Defined on `globalThis` itself, which is what the shipped line reads.
  //
  // The first version spied on `Storage.prototype.removeItem` and passed on
  // node 22 and 24 while failing on 26 — node 26 defines a `localStorage`
  // global of its own, and vitest's jsdom environment skips any key that is
  // already present on `globalThis`, so jsdom's `localStorage` was never
  // installed there. The spy patched a class the object under test was not an
  // instance of. In a content script `globalThis` *is* the window and the
  // distinction does not exist, so this is a test-environment artefact — but
  // one that made the pin runtime-dependent, which is no pin at all.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      removeItem: (key: string) => {
        removed.push(key);
      },
    },
  });
  vi.resetModules();
  await import('../src/content/reset-widget-state.js');
  return removed;
}

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the shipped side effect', () => {
  it('clears the stale key when the page is one of ours', async () => {
    expect(await importOn(OURS)).toEqual(['booking-widget.store']);
  });

  it('clears nothing on the user’s own browsing', async () => {
    expect(await importOn('https://www.avis.com/en/home')).toEqual([]);
  });
});
