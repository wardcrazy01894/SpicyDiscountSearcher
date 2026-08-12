import type { QuoteFailure, Trip, VendorId } from './types.js';

/**
 * Driving a vendor's own search form, for the vendors whose URL cannot express
 * a search.
 *
 * Budget, Enterprise and National keep the itinerary in session state, so no
 * query string can carry it. The only way to price a code at those vendors is
 * to open their form and fill it in, which is what this file is the framework
 * for.
 *
 * `deeplinks.ts` still refuses to build a search URL for any of them — nothing
 * about driving a form makes one possible. What it does for the two that are
 * driven is return the page the form lives on, marked `'driven'`: not a deep
 * link, and deliberately not graded as one.
 *
 * **The doctrine `deeplinks.ts` follows applies here unchanged, and matters
 * more.** A deep link that rots usually lands somewhere obviously wrong; a
 * driver that half-works submits a form with one field stale and returns a real
 * price for a rental nobody asked for. So every step a driver takes is
 * *verified against what the page then renders* rather than assumed to have
 * worked, and a step that cannot be verified fails the quote instead of
 * continuing. `form-fill` is visible in the popup; a wrong price is not.
 *
 * National and Enterprise are both live on this path (`drivers/national.ts`,
 * `drivers/enterprise.ts`). Budget is not: its form is mapped but submitting it
 * raises a bot check, so nothing drives it yet.
 *
 * Read Enterprise's for a form whose date control is a range picker, and
 * National's for one whose submit ends in a real navigation — the two shapes a
 * third driver is most likely to meet.
 */

/**
 * What a driver may fail with.
 *
 * Derived from `QuoteFailure` rather than written out, so deleting or renaming
 * one of these there is a compile error here instead of a drift the tests would
 * not catch.
 */
export type DriverFailure = Extract<
  QuoteFailure,
  'form-fill' | 'form-submit' | 'code-rejected' | 'discount-missing'
>;

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
   * page the form lives on, which is why `LinkConfidence` has `driven` rather
   * than grading it as a deep link.
   */
  startUrl(): string;
  /**
   * The pathname the form lives on, and the only page `drive` may run against.
   *
   * Load-bearing, because **a content script re-runs from the top on every
   * document**. `main()` sends `PROBE_READY` on each load and the background
   * answers with the same quote for the same tab id, which is right for
   * extraction — it is idempotent — and wrong for a driver, which is not.
   * National's submit ends in a real navigation to its results page, so without
   * this gate the re-injected probe drives again against a document with no
   * search form and fails a quote whose search had already succeeded.
   */
  startPath: string;
  /** Fill and submit, or throw `DriverError`. May not survive its own navigation. */
  drive(ctx: DriveContext): Promise<void>;
  /**
   * Check the page the search landed on, whether or not this document drove it.
   *
   * Separate from `drive` for the same reason `startPath` exists: after a
   * navigation the driving document is gone, and the checks that make a driven
   * quote trustworthy — did the search run, did the discount apply — have to
   * happen in whichever document is holding the results. Running them only
   * inside `drive` would mean a navigating vendor is never verified at all.
   */
  verifyResults(ctx: DriveContext): Promise<void>;
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
 * `waitFor`, but never satisfied by the state on the calling tick.
 *
 * **For reading a value back after writing it, where `waitFor` cannot fail.**
 * `setNativeValue` writes through the prototype setter, so `el.value` already
 * equals what was written by the time the next statement runs — and `waitFor`
 * reads before its first sleep. A controlled component that rejects the value
 * does so a microtask or a render later, which is *after* the check has
 * returned successfully.
 *
 * So a read-back written as `waitFor(..., () => el.value === wanted)` tests our
 * own assignment rather than the page's acceptance of it, and passes on a form
 * that threw the value away. That is a wrong price rather than a failed quote:
 * the field falls back to its default, the search runs, and the number comes
 * back as the user's. Measured against a select that reverts in a resolved
 * promise — the check passed and the form was back at its default.
 *
 * One poll of delay is the entire difference, and it is cheap: the driver is
 * already polling at this rate for everything else.
 */
export async function waitForSettled<T>(
  ctx: DriveContext,
  describe: string,
  read: () => T | null | undefined,
  failure: DriverFailure = 'form-fill',
): Promise<T> {
  await ctx.sleep(POLL_MS);
  return waitFor(ctx, describe, read, failure);
}

/**
 * How long to leave a page alone before prompting it a second time.
 *
 * Deliberately generous, and the number matters more than it looks. Probe tabs
 * run in a minimised window, where `setTimeout` is throttled to roughly 1/s and
 * National's suggestion lookup takes about 2s — so a retry on every poll
 * cancelled the request the previous one had started and the page never
 * answered at all. That shipped, and broke every live run. A retry must be rare
 * enough that the thing it is retrying has had a fair chance to finish.
 */
export const RETRY_INTERVAL_MS = 4_000;

/**
 * Wait for the page to do something, prompting it again if it does not.
 *
 * The plain `waitFor` assumes an interaction landed. Twice now that has been
 * false on the live site in ways that cost a whole run: a keystroke typed into
 * a field whose component had not mounted, and a toggle clicked while the
 * widget was still settling from the previous step. Both leave nothing to wait
 * for, so the driver waits out its entire budget and reports a timeout on a
 * form it could have driven.
 *
 * `retry` runs at most every `RETRY_INTERVAL_MS`, never on the first pass —
 * the interaction has already happened by the time this is called, and
 * repeating it immediately is what caused the livelock above. It must be safe
 * to run more than once: nudge a value rather than retype it, and click a
 * toggle only while its panel is closed.
 */
export async function waitWithRetry<T>(
  ctx: DriveContext,
  describe: string,
  read: () => T | null | undefined | false,
  retry: () => void,
  failure: DriverFailure = 'form-fill',
): Promise<T> {
  let last = ctx.now();
  return waitFor(
    ctx,
    describe,
    () => {
      const value = read();
      if (value !== null && value !== undefined && value !== false) return value;
      if (ctx.now() - last >= RETRY_INTERVAL_MS) {
        last = ctx.now();
        retry();
      }
      return null;
    },
    failure,
  );
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

/**
 * Tell a field's own component to look at it again, changing nothing.
 *
 * The gentle half of recovering a lost keystroke. Setting the value again — let
 * alone clearing it first — restarts whatever the component had in flight; this
 * only re-announces the value already there, which is enough for a component
 * that has just finished mounting and missed the original event. Measured on
 * National: a bare `input` on a field already holding `PHL` produced the full
 * suggestion list.
 */
export function nudgeInput(el: HTMLInputElement): void {
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Layout-aware where the browser offers it, `textContent` where it does not.
 *
 * **The fallback must trigger on an empty string, not only on null**, and that
 * distinction cost a day. `innerText` is defined in terms of rendered layout,
 * and a probe tab lives in a minimised window where there is none: measured on
 * National, every suggestion button returned `innerText === ""` while
 * `textContent` held "Philadelphia International Airport (PHL)". Written with
 * `??`, this returned the empty string — so the driver sat in front of
 * seventeen perfectly good options, matched none of them, and timed out saying
 * the autocomplete had never answered.
 *
 * It survived every check because it is invisible from outside a probe tab. The
 * ad-hoc scripts used to drive the live site all wrote `a || b`, so the
 * throwaway harness was more robust than the shipped code and could not
 * reproduce the bug; jsdom leaves `innerText` undefined, so `??` reaches
 * `textContent` there and the unit tests were green too.
 *
 * `innerText` is still preferred when it has anything to say — it is what
 * renders a summary as one line, which `verify-trip.ts` depends on.
 */
export function textOf(el: Element | null | undefined): string {
  if (!el) return '';
  const node = el as HTMLElement;
  // `visibleText` rather than `textContent` for the fallback, so the empty
  // `innerText` of a probe tab does not quietly promote script source into
  // something a check will read as page text.
  return (node.innerText || visibleText(node)).replace(/\s+/g, ' ').trim();
}

/**
 * Elements whose text a reader never sees.
 *
 * `textContent` includes the source of every inline `<script>`, and a probe tab
 * has no layout so `innerText` is empty and every text read falls back to it.
 * That turned two checks inside out: a page inlining an error catalogue
 * containing "cannot be used online" would fail every National quote *and*
 * persist the refusal, and a `"Account Name"` key in an inline analytics payload
 * would satisfy the gate that exists to stop a retail page being reported as a
 * company rate. Both are the kind of string an SPA ships inline as a matter of
 * course.
 */
const UNRENDERED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

/** Text nodes under `node`, skipping script source and any excluded subtree. */
function collectText(node: Node, out: string[], exclude: readonly Element[]): void {
  if (exclude.length > 0 && exclude.includes(node as Element)) return;
  if (node.nodeType === 1 && UNRENDERED.has((node as Element).tagName)) return;
  if (node.nodeType === 3) {
    out.push(node.nodeValue ?? '');
    return;
  }
  for (const child of node.childNodes) collectText(child, out, exclude);
}

/**
 * What a reader would see under `root` — never markup, never script source.
 *
 * Use this rather than `textOf` for anything asked of a whole page or a large
 * region. `textOf` prefers `innerText`, which is already reader-visible when the
 * browser computes it, but in a probe tab it never does.
 */
export function visibleText(root: Element | null | undefined): string {
  if (!root) return '';
  const parts: string[] = [];
  collectText(root, parts, []);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The text under `root`, ignoring everything inside `exclude`.
 *
 * For the question every location readback actually asks: does the branch we
 * picked appear somewhere that is *not* the suggestion menu? The menu contains
 * the branch name by construction — it is where the name came from — so a plain
 * text search of the field's container passes whether or not the click selected
 * anything.
 *
 * Written as a walk rather than "find a leaf element containing the name",
 * which is what this was first. That version assumed the chip's text sits in an
 * element with no children, and a chip marked up as
 * `<div>Tampa International Airport (TPA)<button>Remove</button></div>` has the
 * text in a *non*-leaf — so the check could never pass, and the driver would
 * fail `form-fill` on a form it had filled correctly. Walking text nodes makes
 * no assumption about the shape at all.
 *
 * **Takes a list, because one exclusion is not always enough.** Enterprise
 * renders its suggestions *twice* — a visible `location-dropdown auto-complete`
 * and a 0x0 `location-dropdown__aria-items` mirror for screen readers, measured
 * on the live form 2026-08-12. Excluding only the visible one leaves the mirror
 * holding the branch name, so the readback passes on a click that selected
 * nothing: precisely the "verifying that a dropdown once opened" failure this
 * function exists to prevent, through a second copy of the menu.
 */
export function textOutside(
  root: Element | null,
  exclude: Element | readonly Element[] | null,
): string {
  if (!root) return '';
  const skip = exclude === null ? [] : Array.isArray(exclude) ? exclude : [exclude as Element];
  const parts: string[] = [];
  collectText(root, parts, skip as readonly Element[]);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
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
