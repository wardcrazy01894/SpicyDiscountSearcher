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
  /** Codes the page showed, for the report — kept even when the check passes. */
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
 * Only a code we never asked for is evidence of the wrong trip.
 */
export function checkTrip(trip: Trip, pageText: string): TripCheck {
  const rendered = renderedCodes(pageText);
  if (trip.category !== 'car') return { rendered, unexpected: null };

  const asked = new Set(
    [trip.pickupLocation, trip.dropoffLocation || trip.pickupLocation]
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  return { rendered, unexpected: rendered.find((code) => !asked.has(code)) ?? null };
}
