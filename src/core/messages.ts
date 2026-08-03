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
  { type: 'START_RUN'; plan: SearchPlan } | { type: 'CANCEL_RUN' } | { type: 'GET_STATE' };

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
       * Needed by the vendors whose URL cannot express a search. Budget and
       * Avis deep-link to `/en/home`, which is a home page whatever the query
       * string says; Enterprise and National target a reservation path that a
       * hand-run search never produces. `buildDeepLink` does put the code and
       * every trip field in the query string for all of them — the URL is
       * present but inert, so the values have to be re-delivered somewhere the
       * page will honour.
       *
       * Which of those four is fixable by a better URL and which needs the form
       * driven is not settled here, and every builder in `deeplinks.ts` is
       * unverified against a live site (see README).
       *
       * Not a new exposure. `location.search` already carries the same values
       * into all nine vendor pages, where any script on the page can read it;
       * this payload reaches only the content script's isolated world.
       *
       * Vendors with a working deep link ignore both fields — their trip is
       * already in a URL the site does read.
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
