import type { Offer, RunState, SearchPlan, VendorId } from './types.js';

/** Popup -> background. */
export type PopupRequest =
  { type: 'START_RUN'; plan: SearchPlan } | { type: 'CANCEL_RUN' } | { type: 'GET_STATE' };

/** Content script -> background. */
export type ProbeRequest =
  | { type: 'PROBE_READY' }
  | { type: 'PROBE_RESULT'; offers: Offer[] }
  | { type: 'PROBE_FAILED'; message: string };

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

export const RUN_STATE_EVENT = 'RUN_STATE' as const;
