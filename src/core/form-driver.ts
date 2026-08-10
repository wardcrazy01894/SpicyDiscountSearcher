import type { QuoteFailure, Trip, VendorId } from './types.js';

/**
 * Driving a vendor's own search form, for the vendors whose URL cannot express
 * a search.
 *
 * Budget, Enterprise and National keep the itinerary in session state, so no
 * query string can carry it and `deeplinks.ts` refuses to build one for them.
 * The only way to price a code at those vendors is to open their form and fill
 * it in, which is what this file is the framework for.
 *
 * **The doctrine `deeplinks.ts` follows applies here unchanged, and matters
 * more.** A deep link that rots usually lands somewhere obviously wrong; a
 * driver that half-works submits a form with one field stale and returns a real
 * price for a rental nobody asked for. So every step a driver takes is
 * *verified against what the page then renders* rather than assumed to have
 * worked, and a step that cannot be verified fails the quote instead of
 * continuing. `form-fill` is visible in the popup; a wrong price is not.
 *
 * Nothing here is wired to a live vendor yet — every driver-backed vendor is
 * still `searchable: false`, so `FORM_DRIVERS` is consulted and comes back
 * empty on every real run today. See `drivers/enterprise.ts` for what is
 * measured and what is still missing.
 */

/**
 * What a driver may fail with.
 *
 * Derived from `QuoteFailure` rather than written out, so deleting or renaming
 * one of these there is a compile error here instead of a drift the tests would
 * not catch.
 */
export type DriverFailure = Extract<QuoteFailure, 'form-fill' | 'form-submit' | 'code-rejected'>;

/**
 * A failure with a code attached, so the probe can report *which* end broke.
 *
 * The distinction is the whole reason these are separate codes: `form-fill`
 * means the page was never asked for a price, `form-submit` means it was asked
 * and never answered, and `code-rejected` means it answered by refusing the
 * account number. Collapsing them into one would put "no price appeared" on a
 * run where the vendor told us plainly why.
 */
export class DriverError extends Error {
  constructor(
    readonly failure: DriverFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/**
 * Everything a driver may touch, injected rather than reached for.
 *
 * `now` and `sleep` are parameters because the alternative is a driver that can
 * only be tested by actually waiting: Enterprise's widget can take forty
 * seconds to hydrate, and a test that honestly reproduced that would take forty
 * seconds too. The tests supply a fake clock; the probe supplies the real one.
 */
export interface DriveContext {
  doc: Document;
  trip: Trip;
  code: string;
  /** Absolute wall-clock time, in `now()`'s units, after which to give up. */
  deadline: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface FormDriver {
  /**
   * Where to open the tab for this vendor.
   *
   * A driver's URL is not a deep link and carries no itinerary — it is just the
   * page the form lives on. That is exactly why a driven vendor cannot reuse
   * `LinkConfidence` as it stands: neither `verified` nor `best-effort` says
   * anything true about a URL whose correctness is irrelevant. Deciding what it
   * should say is part of making the first driven vendor searchable, not part
   * of this framework.
   */
  startUrl(): string;
  /** Fill and submit, or throw `DriverError`. Resolves once results are up. */
  drive(ctx: DriveContext): Promise<void>;
}

/** How often to re-check a page that is still catching up. */
export const POLL_MS = 250;

/**
 * Wait for the page to satisfy a condition, or fail the quote saying which one.
 *
 * `describe` is not decoration. Every caller here is waiting on a different
 * piece of somebody else's markup, and when one of them rots the message is the
 * only thing that says which — "could not fill the search form" alone would
 * send the next person to read all of it.
 */
export async function waitFor<T>(
  ctx: DriveContext,
  describe: string,
  read: () => T | null | undefined,
  failure: DriverFailure = 'form-fill',
): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (ctx.now() >= ctx.deadline) {
      throw new DriverError(failure, `timed out waiting for ${describe}`);
    }
    await ctx.sleep(POLL_MS);
  }
}

/**
 * Set an input's value the way a framework-backed page will notice.
 *
 * Assigning `.value` directly updates the DOM and tells React nothing, so the
 * component re-renders from its own state and throws the value away — the
 * field looks filled and submits empty. Going through the prototype's setter
 * and then dispatching `input` is what the page's own listeners are bound to.
 *
 * Measured on Enterprise's form: this is what made the location autocomplete
 * open and the Corporate Account Number field survive submission.
 */
export function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  // Taking the setter off the prototype and calling it against a different
  // receiver is the entire technique, so `unbound-method` is flagging the thing
  // being done on purpose: `el.value = value` is precisely what does not work.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Layout-aware where the browser offers it, `textContent` where it does not.
 *
 * jsdom implements only the latter, and a driver that read `innerText` alone
 * would be untestable — which is the same trap `verify-trip.ts` documents
 * falling into. */
export function textOf(el: Element | null | undefined): string {
  if (!el) return '';
  const node = el as HTMLElement;
  return (node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Does `haystack` contain `token` as a standalone word?
 *
 * Airport codes are three letters and turn up inside ordinary words —
 * this repo has already been bitten by `AUD` inside `Audi`. Matching a bare
 * substring would let "Tampa, FL" satisfy a search for `TPA` in the wrong
 * element.
 */
export function hasToken(haystack: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(haystack);
}

/**
 * The registry lives in `drivers/index.ts`, not here.
 *
 * A driver imports this module for `DriverError` and the helpers, so a registry
 * in this file that imported the drivers back would be a cycle. Splitting it out
 * is the whole reason `drivers/index.ts` exists.
 */
export type FormDriverRegistry = Partial<Record<VendorId, FormDriver>>;
