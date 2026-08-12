/**
 * The list of codes a vendor has refused, and the rules about what goes in it.
 *
 * This store suppresses future attempts, so the interesting tests are the ones
 * about restraint: it must survive junk an older build wrote, it must not grow
 * without bound from a message a page can influence, and — the rule that
 * matters most — only the vendor's own refusal may ever reach it. Recording an
 * inference would let a rotted selector quietly retire a working code.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  clearRejected,
  readRejected,
  recordRejected,
  rejectionKey,
  rejectionSet,
} from '../src/core/rejected-codes.js';

/** The slice of chrome.storage.local this module touches. */
function fakeStore(seed: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get: (key: string) => Promise.resolve({ [key]: data.get(key) }),
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
      return Promise.resolve();
    },
    read: () => data.get('rejectedCodes'),
  };
}

/**
 * The same store, with every read held until `open()`.
 *
 * Reads that are merely *slow* are not enough: equal-delay timers run one
 * callback's microtasks to completion before the next fires, so two calls
 * serialise by accident and a lost update cannot be observed. Once open, later
 * reads pass straight through — otherwise a *correctly* serialised second write
 * would deadlock waiting for a gate nobody is left to open.
 */
function heldReads(inner: ReturnType<typeof fakeStore>) {
  let open = false;
  const waiting: Array<() => void> = [];
  return {
    store: {
      get: (key: string) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const read = (): void => void inner.get(key).then(resolve);
          if (open) read();
          else waiting.push(read);
        }),
      set: inner.set,
    },
    open: () => {
      open = true;
      for (const read of waiting.splice(0)) read();
    },
  };
}

describe('recordRejected', () => {
  it('remembers a refusal so the code is not raced again', async () => {
    const store = fakeStore();
    await recordRejected(store, 'national', 'XZ15J55', 1_000);
    const entries = (await readRejected(store))!;
    expect(entries).toEqual([{ vendor: 'national', code: 'XZ15J55', at: 1_000 }]);
    expect(rejectionSet(entries).has(rejectionKey('national', 'XZ15J55'))).toBe(true);
  });

  it('keeps the first timestamp rather than re-stamping on every run', async () => {
    const store = fakeStore();
    await recordRejected(store, 'national', 'XZ15J55', 1_000);
    await recordRejected(store, 'national', 'XZ15J55', 9_000);
    const entries = (await readRejected(store))!;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.at).toBe(1_000);
  });

  it('keeps both when two refusals land together', async () => {
    // Read-modify-write with no atomicity underneath it: both calls read the
    // same list inside one `get` round trip and the second `set` drops the
    // first. Two lanes at a driven vendor is how that happens, and the cost is
    // the exact bug this store exists to prevent — a refused code left in the
    // plan, raced again next run, and counted on the vendor's chip.
    const store = fakeStore();
    // A held read rather than a slow one. Two `setTimeout`s of equal delay do
    // *not* overlap — node drains microtasks between timer callbacks, so the
    // first call runs to completion before the second one even reads, and the
    // fake serialises the very thing the test is trying to interleave. Measured,
    // after that version passed with the queue removed. This holds every read
    // until the gate opens, so both are genuinely in flight at once.
    const held = heldReads(store);

    const both = Promise.all([
      recordRejected(held.store, 'national', 'XZ15J55', 1),
      recordRejected(held.store, 'national', 'XZ45B65', 1),
    ]);
    await Promise.resolve();
    held.open();
    await both;

    const codes = (await readRejected(store))!.map((entry) => entry.code);
    expect(codes.sort()).toEqual(['XZ15J55', 'XZ45B65']);
  });

  it('does not let a refusal land behind a clear that came after it', async () => {
    // The order a user would report as "try them again didn't work". The clear
    // is asked for second, so it must win — but it needs no `get`, while the
    // record in front of it is still waiting on one, so unserialised the clear
    // lands first and the refusal reappears on top of it.
    const store = fakeStore();
    const held = heldReads(store);

    const recording = recordRejected(held.store, 'national', 'XZ15J55', 1);
    const clearing = clearRejected(held.store);
    await Promise.resolve();
    held.open();
    await Promise.all([recording, clearing]);

    expect(await readRejected(store)).toEqual([]);
  });

  it('moves on from a write that never settles', async () => {
    // A rejection cannot wedge the chain — every link swallows its own failure —
    // but a *hang* could, and `chrome.storage` promises nothing about settling.
    // One call that never returned left the queue pending for the life of the
    // worker: later refusals silently queued behind it, which is the accepted
    // trade, and every clear did too — so "try them again" reported failure
    // forever however often it was pressed. Bounding the waiter in the service
    // worker does not help; the queue itself has to move on.
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const hung = { ...store, set: () => new Promise<void>(() => {}) };

      const stuck = recordRejected(hung, 'national', 'NEVER', 1);
      const after = clearRejected(store);
      // Past the per-link bound.
      await vi.advanceTimersByTimeAsync(6_000);
      await Promise.all([stuck, after]);

      // The clear behind it ran, which is the whole point.
      expect(await readRejected(store)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an abandoned refusal undo the clear that overtook it', async () => {
    // Abandoning a link does not cancel it: the body runs on, still holding the
    // list it read before the clear. Writing that back restores every refusal
    // the clear removed — and invisibly, because the popup has already re-read
    // an empty list, so it reports success and schedules no recheck. The codes
    // reappear on the next open with nothing to explain them.
    //
    // The *read* is what hangs here, which is the case a check before the write
    // can close. A hanging `set` is already with the platform by the time a
    // clear can be asked for; that one is left open and recorded in the module.
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      let releaseRead: (() => void) | undefined;
      const slowRead = {
        ...store,
        get: (key: string) =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseRead = () => void store.get(key).then(resolve);
          }),
      };

      // Seed a refusal so the clear has something to remove.
      await recordRejected(store, 'national', 'OLD', 1);

      const recording = recordRejected(slowRead, 'national', '5666666', 1);
      const clearing = clearRejected(store);
      // The record is abandoned mid-read; the clear runs and empties the store.
      await vi.advanceTimersByTimeAsync(6_000);
      await clearing;
      expect(await readRejected(store)).toEqual([]);

      // Now the abandoned read finally returns, holding the pre-clear list.
      releaseRead?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await recording;

      // Still empty. Losing that refusal is the accepted cost; putting `OLD`
      // back after the user cleared it is not.
      expect(await readRejected(store)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an abandoned refusal drop the one that overtook it', async () => {
    // The lost update this queue exists to prevent, arriving through the
    // timeout added to stop the queue wedging. A's read stalls past the bound,
    // the chain moves on, B reads without A and writes `[B]` — then A wakes
    // holding its pre-B list and writes it back, dropping B. The `clears` guard
    // does not see this: no clear is involved.
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      let releaseRead: (() => void) | undefined;
      let stallNextRead = true;
      const stalling = {
        ...store,
        get: (key: string) => {
          if (!stallNextRead) return store.get(key);
          stallNextRead = false;
          return new Promise<Record<string, unknown>>((resolve) => {
            releaseRead = () => void store.get(key).then(resolve);
          });
        },
      };

      const first = recordRejected(stalling, 'national', 'A', 1);
      const second = recordRejected(stalling, 'national', 'B', 2);
      // A is abandoned mid-read; B runs and lands.
      await vi.advanceTimersByTimeAsync(6_000);
      await second;
      expect((await readRejected(store))!.map((e) => e.code)).toEqual(['B']);

      // A's read finally returns, holding the list from before B.
      releaseRead?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;

      // B survives. Losing A is the accepted cost of the timeout; losing B —
      // a refusal that was recorded successfully — is not.
      expect((await readRejected(store))!.map((e) => e.code)).toEqual(['B']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why a refusal was not stored, not just that it was not', async () => {
    // A write the queue abandoned resolves like any other, so `settleWrites`
    // counts it as landed and nothing else notices — while the user has already
    // been told the vendor refused this code and the run will ask again next
    // time. The caller needs to be able to say so.
    const store = fakeStore();
    expect(await recordRejected(store, 'national', 'A', 1)).toBe('stored');
    // Already known is a success too, from the caller's point of view.
    expect(await recordRejected(store, 'national', 'A', 2)).toBe('already-known');

    // A read that failed is not an empty store, and saying so is what stops the
    // write replacing everything with one entry.
    const unreadable = { ...store, get: () => Promise.reject(new Error('no storage')) };
    expect(await recordRejected(unreadable, 'national', 'C', 4)).toBe('unreadable');
    expect((await readRejected(store))!.map((e) => e.code)).toEqual(['A']);

    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const stalling = {
        ...store,
        get: (key: string) =>
          new Promise<Record<string, unknown>>((resolve) => {
            release = () => void store.get(key).then(resolve);
          }),
      };
      const abandoned = recordRejected(stalling, 'national', 'B', 3);
      await vi.advanceTimersByTimeAsync(6_000);
      release?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(await abandoned).toBe('abandoned');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the same code at two vendors apart', async () => {
    // Enterprise files the codes National honours, so the same string can be
    // refused at one brand and fine at another.
    const store = fakeStore();
    await recordRejected(store, 'national', 'XZ15J55', 1);
    await recordRejected(store, 'enterprise', 'XZ15J55', 1);
    expect(await readRejected(store)).toHaveLength(2);
  });
});

describe('readRejected', () => {
  it('is empty when nothing has been refused', async () => {
    expect(await readRejected(fakeStore())).toEqual([]);
  });

  it('survives whatever an older build left behind', async () => {
    // Persisted state outlives the code that wrote it, and a throw here would
    // take the popup's whole startup with it.
    const store = fakeStore({ rejectedCodes: 'not an array' });
    expect(await readRejected(store)).toEqual([]);
  });

  it('drops malformed entries rather than trusting the shape', async () => {
    const store = fakeStore({
      rejectedCodes: [
        { vendor: 'national', code: 'GOOD', at: 1 },
        { vendor: 'national' },
        null,
        'nonsense',
        // `at` is compared, so it has to be a number. The popup tells a refusal
        // that survived a clear from one recorded after it by asking whether
        // `at` predates the clear, and `undefined <= number` is `false` — so an
        // entry an older build wrote without a timestamp read as "recorded
        // afterwards", and a failed clear reported success while the code went
        // on being filtered out of the chips, the list and the plan.
        { vendor: 'national', code: 'NOSTAMP' },
        { vendor: 'national', code: 'BADSTAMP', at: 'yesterday' },
      ],
    });
    expect(await readRejected(store)).toEqual([{ vendor: 'national', code: 'GOOD', at: 1 }]);
  });

  it('says null rather than empty when storage is unavailable', async () => {
    // The distinction the store is built on. Collapsed to `[]`, one failed read
    // let `recordRejected` write a single-entry list over everything the vendors
    // had already refused, and let the popup report a failed clear as a success.
    const broken = {
      get: () => Promise.reject(new Error('no storage')),
      set: () => Promise.resolve(),
    };
    expect(await readRejected(broken)).toBeNull();
  });
});

describe('clearRejected', () => {
  it('forgets everything, so a vendor can be asked again', async () => {
    // The undo half. A cache of somebody else's answer that cannot be dropped
    // is a permanent, invisible edit to the user's own code list.
    const store = fakeStore();
    await recordRejected(store, 'national', 'XZ15J55', 1);
    await clearRejected(store);
    expect(await readRejected(store)).toEqual([]);
  });
});
