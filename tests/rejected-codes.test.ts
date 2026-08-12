/**
 * The list of codes a vendor has refused, and the rules about what goes in it.
 *
 * This store suppresses future attempts, so the interesting tests are the ones
 * about restraint: it must survive junk an older build wrote, it must not grow
 * without bound from a message a page can influence, and — the rule that
 * matters most — only the vendor's own refusal may ever reach it. Recording an
 * inference would let a rotted selector quietly retire a working code.
 */
import { describe, expect, it } from 'vitest';

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
