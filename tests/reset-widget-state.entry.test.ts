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

async function importOn(href: string): Promise<string[]> {
  const removed: string[] = [];
  // jsdom forbids assigning `location`, and its origin is fixed for the file by
  // the environment options above — hence the avis.com origin there, with only
  // the path and query moved per case.
  const target = new URL(href);
  window.history.replaceState({}, '', target.pathname + target.search);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
    removed.push(key);
  });
  vi.resetModules();
  await import('../src/content/reset-widget-state.js');
  return removed;
}

afterEach(() => {
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
