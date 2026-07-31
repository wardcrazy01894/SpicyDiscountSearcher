import type { Offer, ProbeReport, QuoteFailure, RunState, SearchPlan, VendorId } from './types.js';

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
  | { type: 'PROBE_START'; vendor: VendorId; quoteId: string; timeoutMs: number }
  | { type: 'PROBE_IDLE' };

/** Background -> popup, both as a GET_STATE reply and as a live broadcast. */
export interface StateMessage {
  type: 'RUN_STATE';
  state: RunState | null;
}
