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
       * Only needed by vendors that cannot be deep-linked at all: Enterprise
       * keeps its search in session state, so the URL the tab opens on carries
       * nothing and this is the only channel the trip can reach the page by.
       * Vendors with a working deep link ignore both fields — the trip is
       * already in their URL.
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
