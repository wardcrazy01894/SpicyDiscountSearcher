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
        typeof (entry as RejectedCode).code === 'string' &&
        // `at` too, now that something compares it. The popup tells a refusal
        // that survived a clear from one recorded after it by asking whether
        // `at` predates the clear — and `undefined <= number` is `false`, so an
        // entry an older build wrote without a timestamp read as "recorded
        // afterwards": a failed clear reported success, with the code still
        // filtered out of the chips, the list and the plan for the session.
        // Dropping it here rather than special-casing it there, because this is
        // the function whose job is not trusting what it reads.
        typeof (entry as RejectedCode).at === 'number',
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
 * Module-level rather than per-store: the store argument exists so tests can
 * pass a fake, but production has one `chrome.storage.local`, and a per-store
 * queue would serialise against the wrong thing.
 *
 * **It orders one realm, and that is the whole reason `CLEAR_REJECTED` is a
 * message.** The popup and the service worker each get their own instance of
 * this module, so `writes` would be two independent chains and nothing here
 * could order a popup's clear against a worker's in-flight record — the clear
 * lands between that record's read and its write, the write puts every cleared
 * refusal back, and the popup looks correct until it is next opened. Routing the
 * clear through the worker makes both writers the same realm, which is what
 * makes this queue the whole story rather than half of it.
 *
 * Every link swallows its own failure, so a *rejection* cannot wedge the chain.
 * A **hang** is the other half and needed its own answer: `chrome.storage` makes
 * no promise of ever settling, and one call that never returns left `writes`
 * pending for the life of the worker — every later refusal silently queued
 * behind it (the accepted trade) and, much worse, every `CLEAR_REJECTED` too, so
 * "try them again" reported "not cleared yet" forever no matter how often it was
 * pressed. Bounding the *waiter* in the service worker does not help; the queue
 * itself has to move on. Each link is therefore abandoned after
 * `WRITE_TIMEOUT_MS`.
 *
 * Abandoning is not cancelling — a write that was merely slow may still land
 * afterwards, out of order — and that is accepted for a *late refusal*, which
 * costs a wasted tab the user can see. It is **not** accepted for a clear
 * undone: the popup has already re-read an empty list by then, so it reports
 * success and schedules no recheck, and the codes simply reappear on the next
 * open with nothing to explain them. `recordRejected` therefore refuses to
 * write a list it read before a clear was asked for.
 *
 * That closes it when the *read* was the slow part. Two orderings stay open,
 * both needing a `set` slower than `WRITE_TIMEOUT_MS`, and both left open on
 * purpose rather than for want of noticing:
 *
 * - An abandoned **record** whose `set` was already issued cannot be retracted,
 *   so it can still land after a clear and restore what was cleared.
 * - An abandoned **clear** can land after a later refusal and erase it, which
 *   costs one wasted tab on the next run.
 *
 * Closing either needs a compare-and-swap `chrome.storage` does not offer, or a
 * compensating re-write that then has to be ordered against every legitimate
 * write after it — more machinery, with its own orderings to get wrong, for
 * failures that need the platform to stall for five seconds. The guard above
 * is kept because it costs one comparison; these are not.
 */
export const WRITE_TIMEOUT_MS = 5_000;

/**
 * The longest anything will wait for this queue, however deep it is.
 *
 * Lives here rather than in the service worker because both sides of the clear
 * need it: the worker sizes its wait as `WRITE_TIMEOUT_MS x depth` capped by
 * this, and the popup's single recheck has to outlast whatever the worker
 * actually waited. With it defined next to the per-write bound, "how long could
 * the worker have waited" is answerable from one place instead of being guessed
 * at across a module boundary.
 */
export const WRITE_WAIT_CEILING_MS = 30_000;

let writes: Promise<void> = Promise.resolve();

/** Links queued and not yet settled, so a waiter can size its own bound. */
let queued = 0;

/**
 * How many links are queued and not yet finished *or abandoned*.
 *
 * The service worker bounds its wait by how long the chain can honestly take,
 * and every function here returns the *tail* of that chain — so a caller
 * counting its own promises sees one and budgets for one write, however many
 * are queued in front of it.
 *
 * "Or abandoned" is the honest part of the name. A link that timed out is
 * dropped from this count while its `storage.set` may still be outstanding, so
 * under exactly the slow-storage conditions the scaling exists for this can
 * read low and a waiter can size its bound short. Counted on real completion
 * instead, a single hung write would pin the number up for the life of the
 * worker and every later bound would sit at the ceiling — a permanent cost for
 * a transient one. The waiter is bounded either way; only its generosity
 * moves.
 */
export function pendingWrites(): number {
  return queued;
}

function serialise(write: (abandoned: () => boolean) => Promise<void>): Promise<void> {
  queued += 1;
  const bounded = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The queue moved on without this link. Anything it read before that point
    // describes a state later writes have already replaced, so a body that
    // wakes up holding one must not write it back.
    let gaveUp = false;
    try {
      await Promise.race([
        write(() => gaveUp),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            gaveUp = true;
            resolve();
          }, WRITE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      // Or a healthy write leaves a live timer behind on every call.
      if (timer !== undefined) clearTimeout(timer);
      queued -= 1;
    }
  };
  writes = writes.then(bounded, bounded);
  return writes;
}

/** Remember a refusal, keeping the first timestamp for one already known. */
export function recordRejected(
  storage: RejectionStore,
  vendor: VendorId,
  code: string,
  at: number,
): Promise<void> {
  return serialise(async (abandoned) => {
    // Inside the queue, not before it: reading ahead of the writes in front of
    // this one is precisely the lost update.
    const existing = await loadRejected(storage);
    if (existing.some((e) => rejectionKey(e.vendor, e.code) === rejectionKey(vendor, code))) return;
    if (existing.length >= MAX_ENTRIES) return;
    // Abandoning a link does not cancel it, so this body can still be running
    // after the queue moved on — and the list it read is then stale. Writing it
    // back undoes whatever ran in the meantime: a clear, invisibly (the popup
    // has already re-read an empty list, so it reports success and schedules no
    // recheck), or another refusal, which is the lost update this queue exists
    // to prevent arriving through the timeout added to stop the queue wedging.
    //
    // One check covers both. A separate clear counter used to sit here as well,
    // captured at enqueue; it was redundant — links are strictly serialised, so
    // nothing can interleave between this read and this write *unless* the link
    // was abandoned, which is exactly what this tests. The one case the two
    // disagreed on was a clear merely queued behind a live record, where
    // skipping and writing produce the same stored state because the clear
    // wipes it either way.
    //
    // This closes the case where the read was the slow part. It cannot close
    // the case where the *write* was: that `set` is already with the platform
    // by the time anything can overtake it, and there is no compare-and-swap
    // here to make it conditional. See the module comment.
    if (abandoned()) return;
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
