import type { Trip } from './types.js';

/**
 * Does the page we landed on describe the trip we asked for?
 *
 * The failure this exists for is the worst shape in this codebase: a real page,
 * a real price, and a different rental. Avis persists its booking widget in
 * `localStorage` and lets that state outrank the query string, so a profile
 * that had once searched Philadelphia rendered "Tampa Intl Airport (TPA) -
 * Philadelphia Intl Airport (PHL)" for a URL asking TPA to TPA. Nothing
 * downstream could tell: `landedElsewhere` only fires on the site root, the
 * quote is `ok`, and its price ranks like any other.
 *
 * `reset-widget-state.ts` stops that happening. This is the check that catches
 * it when the prevention fails — a different vendor, a renamed storage key, a
 * second mechanism nobody has found yet. Prevention without detection would
 * mean trusting that a fix stayed fixed.
 *
 * Deliberately opt-in per vendor, like `VENDOR_SELECTORS`. It reads whatever
 * summary the vendor happens to render, which is exactly the kind of knowledge
 * that rots, and a false "this is the wrong trip" would throw away a good quote.
 */

/**
 * Airport codes as a page renders them, e.g. "Tampa Intl Airport (TPA)".
 *
 * Parenthesised and three letters, which is how every vendor summary seen so
 * far writes them. Bare three-letter tokens are not matched on purpose: prose
 * is full of them ("SUV", "USD", "All"), and a false positive here discards a
 * quote that was fine.
 */
const RENDERED_CODE_RE = /\(([A-Z]{3})\)/g;

/** How much of the page can plausibly be the trip summary. */
const SUMMARY_CHARS = 400;

export function renderedCodes(text: string): string[] {
  const head = text.slice(0, SUMMARY_CHARS);
  return [...new Set([...head.matchAll(RENDERED_CODE_RE)].map((m) => m[1]!))];
}

export interface TripCheck {
  /** Codes the page showed. Only surfaced today when the check fails, in the
   *  failure message — nothing records them on the passing path. */
  rendered: string[];
  /** A code the page showed that the trip never mentioned, if any. */
  unexpected: string | null;
}

/**
 * Compare what the page shows against the trip we asked for.
 *
 * Reports rather than judges: the caller decides what an `unexpected` code
 * means. A page showing *fewer* codes than expected is not a failure — Avis
 * with a cleared store renders "Tampa Intl Airport (TPA) - Select drop-off
 * location", which is the correct round trip with the drop-off simply unstated.
 *
 * An unexpected code is only reported when one of the asked-for codes is
 * rendered *too*, and that precondition is the difference between a guard and a
 * liability. `(USD)`, `(EST)`, `(GPS)` are all parenthesised uppercase triplets
 * a booking page might carry, and without it a currency selector appearing
 * above the summary would fail every Avis quote in every run while the popup
 * announced "the page priced a different trip" about a correct page. The
 * observed failure had `TPA` present alongside the stale `PHL`, so requiring
 * the anchor costs nothing there.
 *
 * What it gives up, stated rather than discovered later: a page that replaced
 * *both* ends of the trip is invisible to this. That is a narrower hole than a
 * whole-vendor false positive, and the reset script is what makes it unlikely.
 *
 * Silent when it finds nothing at all, too — if the summary moves past
 * `SUMMARY_CHARS`, or drops its parentheses, `rendered` is empty, no anchor is
 * present, and the quote passes unchecked. A detector that stops working looks
 * exactly like one with nothing to report.
 */
export function checkTrip(trip: Trip, pageText: string): TripCheck {
  if (trip.category !== 'car') return { rendered: [], unexpected: null };
  const rendered = renderedCodes(pageText);

  const asked = new Set(
    [trip.pickupLocation, trip.dropoffLocation || trip.pickupLocation]
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  const anchored = rendered.some((code) => asked.has(code));
  if (!anchored) return { rendered, unexpected: null };
  return { rendered, unexpected: rendered.find((code) => !asked.has(code)) ?? null };
}
