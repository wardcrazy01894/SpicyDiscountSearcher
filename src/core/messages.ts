import type {
  Offer,
  ProbeReport,
  QuoteFailure,
  RunState,
  SearchPlan,
  Trip,
  VendorId,
} from './types.js';

/** Popup -> background. */
export type PopupRequest =
  | { type: 'START_RUN'; plan: SearchPlan }
  | { type: 'CANCEL_RUN' }
  | { type: 'GET_STATE' }
  /**
   * Forget every refused code.
   *
   * A message rather than the popup writing storage itself, and the reason is
   * the only reason: `recordRejected` is read-modify-write, and the popup and
   * the service worker are different JS realms with their own module state, so
   * nothing in `rejected-codes.ts` can order a popup's clear against a write
   * the worker already has in flight. A clear landing between the worker's read
   * and its write is undone by that write, and every refusal the user asked to
   * forget comes back — invisibly, because the popup has already emptied its
   * own copy and looks correct until it is next opened.
   *
   * Routed here, both writers are the worker, and its queue is then the whole
   * story.
   */
  | { type: 'CLEAR_REJECTED' };

/** Content script -> background. */
export type ProbeRequest =
  | { type: 'PROBE_READY' }
  // Both carry a report: the facts that separate a real quote from a deep link
  // that quietly landed on the vendor's home page are the same either way.
  | { type: 'PROBE_RESULT'; offers: Offer[]; report: ProbeReport }
  | { type: 'PROBE_FAILED'; failure: QuoteFailure; message: string; report: ProbeReport };

export type BackgroundRequest = PopupRequest | ProbeRequest;

/** Background's answer to PROBE_READY: scrape as this vendor, or stand down. */
export type ProbeAssignment =
  | {
      type: 'PROBE_START';
      vendor: VendorId;
      quoteId: string;
      timeoutMs: number;
      /**
       * The itinerary and code to type into the vendor's own search form.
       *
       * Needed by the vendors whose URL cannot express a search: Budget,
       * Enterprise and National, whose sites ignore the query string entirely.
       * Their builders now refuse to produce a URL at all and they are
       * `searchable: false`, so nothing routes a run to them — the fields exist
       * for the driver that will.
       *
       * Not a new exposure. `buildDeepLink` already puts the code and every
       * trip field into `location.search` for every vendor it does build for,
       * where any script on the page can read it; this payload reaches only the
       * content script's isolated world.
       *
       * Vendors with a working deep link ignore both fields — their trip is
       * already in a URL the site reads.
       */
      trip: Trip;
      code: string;
    }
  | { type: 'PROBE_IDLE' };

/** Background -> popup, both as a GET_STATE reply and as a live broadcast. */
export interface StateMessage {
  type: 'RUN_STATE';
  state: RunState | null;
}
