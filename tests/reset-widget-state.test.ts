import { describe, expect, it } from 'vitest';

import { clearStaleState, shouldClear } from '../src/content/reset-widget-state.js';

/**
 * The prevention half of the Avis fix, which shipped untested in its first
 * draft: changing the host to `avis.com` and the key to `booking-widgetXstore`
 * left the whole suite green, so both halves of the mechanism could be broken
 * without a single failure.
 */

const OURS = new URL(
  'https://www.avis.com/en/reservation/vehicle-availability?pickup_location_code=TPA&awd_number=D486600',
);

function fakeStorage(): { removed: string[]; removeItem: (key: string) => void } {
  const removed: string[] = [];
  return { removed, removeItem: (key) => removed.push(key) };
}

/** Storage read as a thunk, because the access itself can throw. */
const from = (storage: Pick<Storage, 'removeItem'> | undefined) => () => storage;

describe('shouldClear', () => {
  it('fires on our own search link', () => {
    expect(shouldClear(OURS)).toBe(true);
  });

  it('leaves the user’s own browsing alone', () => {
    // The failure this prevents is not hypothetical: the user fills the widget
    // by hand and hits Search, and the results navigation would erase their
    // drop-off before the page hydrates — causing the exact bug this file
    // exists to fix, on a search we were never asked about.
    expect(shouldClear(new URL('https://www.avis.com/en/home'))).toBe(false);
    expect(shouldClear(new URL('https://www.avis.com/en/reservation/make-reservation'))).toBe(
      false,
    );
    // Same page, but reached by the user rather than by a deep link of ours:
    // no discount code in the query.
    expect(
      shouldClear(new URL('https://www.avis.com/en/reservation/vehicle-availability?x=1')),
    ).toBe(false);
  });

  it('does not touch another vendor', () => {
    expect(shouldClear(new URL('https://www.hertz.com/us/en/book/vehicles?CDP=1'))).toBe(false);
  });
});

describe('clearStaleState', () => {
  it('removes exactly the key that was measured', () => {
    // Named literally. The key is Avis's implementation detail, so a rename
    // here silently turns the whole fix into a no-op — which is how the first
    // draft could be disabled with the suite green.
    const storage = fakeStorage();
    expect(clearStaleState(OURS, from(storage))).toBe(true);
    expect(storage.removed).toEqual(['booking-widget.store']);
  });

  it('removes nothing on a page that is not ours', () => {
    const storage = fakeStorage();
    expect(clearStaleState(new URL('https://www.avis.com/en/home'), from(storage))).toBe(false);
    expect(storage.removed).toEqual([]);
  });

  it('survives storage being unavailable', () => {
    // Partitioned, disabled, quota-evicted. `verify-trip` is what turns the
    // resulting inaccuracy into a visible failure, so there is nothing to
    // report from here — but throwing would take the page down with it.
    const throwing = {
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(() => clearStaleState(OURS, from(throwing))).not.toThrow();
    expect(clearStaleState(OURS, from(throwing))).toBe(false);
  });

  it('does nothing when there is no storage at all', () => {
    expect(clearStaleState(OURS, from(undefined))).toBe(false);
  });

  it('survives the storage access itself throwing', () => {
    // Chrome throws SecurityError on the property access, not on removeItem,
    // when site data is blocked — so reading it outside the try would take the
    // page down while the catch sat there looking like it handled this.
    expect(() =>
      clearStaleState(OURS, () => {
        throw new Error('SecurityError');
      }),
    ).not.toThrow();
  });
});
