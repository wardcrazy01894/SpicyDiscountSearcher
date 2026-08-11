import type { VendorId } from './types.js';

/**
 * Codes a vendor has told us, in its own words, that it will not accept.
 *
 * Racing one costs a real tab on a real vendor site and can only ever fail, so
 * once a vendor has refused a code there is no reason to ask again. National
 * refuses several of the contract ids in the workbook — Accenture's `XZ15J55`
 * among them — and every run was spending a lane rediscovering that.
 *
 * ## What may be recorded here, and what may not
 *
 * Only `code-rejected`, which is the vendor's own sentence ("this account
 * number cannot be used online"), and never `discount-missing`, which is *our*
 * inference that a discount did not land. The difference matters because this
 * store suppresses future attempts: recording an inference would let a selector
 * that rotted against a redesign quietly retire a perfectly good code, and the
 * user would see the code simply stop appearing with nothing to explain it.
 *
 * The same reasoning bounds what this is allowed to be. It is a cache of an
 * observation, not a judgement — so it is visible in the popup, clearable in
 * one click, and holds a timestamp so a stale entry can be reasoned about
 * later. A vendor that starts honouring a code again is a thing that happens;
 * a tool that can never notice is worse than one that occasionally re-asks.
 */

const KEY = 'rejectedCodes';

/**
 * A cap, because this is written from a message a page can influence.
 *
 * `chrome.storage.local` has a quota and `publish()` swallows a write failure
 * into a warn, so an unbounded store fails silently and takes the run state's
 * persistence with it. Far above any real workbook: there are 555 codes in the
 * database in total.
 */
const MAX_ENTRIES = 1_000;

export interface RejectedCode {
  vendor: VendorId;
  code: string;
  /** When the vendor said so, so a stale entry can be judged rather than guessed at. */
  at: number;
}

export function rejectionKey(vendor: VendorId, code: string): string {
  return `${vendor}:${code}`;
}

/**
 * Just the two calls this needs, structurally.
 *
 * Not `Pick<chrome.storage.LocalStorageArea, …>`: that type's `get` is a set of
 * overloads including callback forms, which nothing can satisfy in a test fake
 * and which say more than this module cares about.
 */
export interface RejectionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadRejected(storage: RejectionStore): Promise<RejectedCode[]> {
  try {
    const stored = await storage.get(KEY);
    const list: unknown = stored[KEY];
    if (!Array.isArray(list)) return [];
    // Read defensively: this is persisted state that an older build wrote and a
    // newer one has to survive.
    return list.filter(
      (entry): entry is RejectedCode =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as RejectedCode).vendor === 'string' &&
        typeof (entry as RejectedCode).code === 'string',
    );
  } catch {
    // Storage being unavailable costs a wasted tab, not correctness — the run
    // simply re-asks. Never worth failing a race over.
    return [];
  }
}

/**
 * Every write, in order.
 *
 * `recordRejected` is read-modify-write, and `chrome.storage` gives it no
 * atomicity: two refusals settling inside one `get` round trip both read the
 * same list and the second `set` drops the first. Two lanes at a driven vendor
 * is exactly how that happens, and the cost is the bug this whole store exists
 * to prevent — a refused code silently kept in the plan and raced again next
 * run, now with a chip counting it.
 *
 * Module-level rather than per-store because there is one
 * `chrome.storage.local` behind every caller; a per-store queue would serialise
 * against the wrong thing. The chain never rejects — every link swallows its own
 * failure — so it cannot wedge.
 */
let writes: Promise<void> = Promise.resolve();

function serialise(write: () => Promise<void>): Promise<void> {
  writes = writes.then(write, write);
  return writes;
}

/** Remember a refusal, keeping the first timestamp for one already known. */
export function recordRejected(
  storage: RejectionStore,
  vendor: VendorId,
  code: string,
  at: number,
): Promise<void> {
  return serialise(async () => {
    // Inside the queue, not before it: reading ahead of the writes in front of
    // this one is precisely the lost update.
    const existing = await loadRejected(storage);
    if (existing.some((e) => rejectionKey(e.vendor, e.code) === rejectionKey(vendor, code))) return;
    if (existing.length >= MAX_ENTRIES) return;
    try {
      await storage.set({ [KEY]: [...existing, { vendor, code, at }] });
    } catch {
      // Same trade as above.
    }
  });
}

export function clearRejected(storage: RejectionStore): Promise<void> {
  // On the same queue: a clear that overtook an in-flight record would leave the
  // record behind, which reads to the user as "try them again" not working.
  return serialise(async () => {
    try {
      await storage.set({ [KEY]: [] });
    } catch {
      // Same trade as above.
    }
  });
}

/** The set a plan should skip, in the shape `buildCandidates` keys on. */
export function rejectionSet(entries: RejectedCode[]): Set<string> {
  return new Set(entries.map((e) => rejectionKey(e.vendor, e.code)));
}
