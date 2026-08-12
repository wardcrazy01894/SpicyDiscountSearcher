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
  | { type: 'PROBE_FAILED'; failure: QuoteFailure; message: string; report: ProbeReport }
  /**
   * The vendor's form has mounted, so its window need not stay painted.
   *
   * Only paint-gated vendors ever cause a visible window (see
   * `Vendor.needsPaintedWindow`), and this is what ends that. It settles
   * nothing and carries no evidence — a forged one costs at most a window
   * minimised early, which is the direction that is safe.
   */
  | { type: 'PROBE_HYDRATED' };

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
       * National and Enterprise are driven and `searchable: true`, so these
       * fields carry real runs. Budget's builder still refuses to produce a URL
       * and it is `searchable: false`, so nothing routes a run to it — the
       * fields wait for the driver that will.
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
