import type { LinkConfidence } from './deeplinks.js';

export type Category = 'car' | 'hotel';

export type VendorId =
  | 'hertz'
  | 'avis'
  | 'budget'
  | 'enterprise'
  | 'national'
  | 'sixt'
  | 'hilton'
  | 'marriott'
  | 'hyatt'
  | 'starwood';

export interface Vendor {
  id: VendorId;
  label: string;
  category: Category;
  /** What this vendor calls its discount code, e.g. Hertz "CDP". */
  codeLabel: string;
  /** Primary host, used for host_permissions and content-script matching. */
  host: string;
  /**
   * False for vendors we can list codes for but not price-check — Starwood was
   * folded into Marriott in 2018, so its SET numbers have no site to search.
   */
  searchable: boolean;
  /**
   * Vendors that honour the same code. The spreadsheet keeps one shared
   * "Enterprise / National" column because the two brands share contract ids.
   */
  alsoTryAs?: VendorId[];
}

/** One discount code for one company at one vendor, as parsed from the workbook. */
export interface CodeRecord {
  vendor: VendorId;
  /** Null when the workbook only gave a booking URL, e.g. Deloitte's Hilton link. */
  code: string | null;
  note: string | null;
  url: string | null;
  /**
   * Workbook sheets that listed this code. Written by extract_codes.py and
   * deliberately unread here: it is provenance for the data pipeline, not
   * something the extension acts on.
   */
  sources: string[];
}

export interface Company {
  slug: string;
  name: string;
  codes: CodeRecord[];
}

export interface CodeDatabase {
  schemaVersion: number;
  companies: Company[];
}

export interface CarTrip {
  category: 'car';
  pickupLocation: string;
  /** Empty means same as pickup. */
  dropoffLocation: string;
  /** ISO yyyy-mm-dd. */
  pickupDate: string;
  /** 24h HH:mm. */
  pickupTime: string;
  dropoffDate: string;
  dropoffTime: string;
}

export interface HotelTrip {
  category: 'hotel';
  destination: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
}

export type Trip = CarTrip | HotelTrip;

/** A single (company, vendor, code) combination we can price-check. */
export interface Candidate {
  companySlug: string;
  companyName: string;
  vendor: VendorId;
  code: string;
  note: string | null;
}

export type QuoteStatus = 'pending' | 'loading' | 'ok' | 'no-price' | 'error' | 'cancelled';

/**
 * What a scraped number actually means. Comparing a nightly rate against a trip
 * total would silently pick the wrong winner, so every offer records its basis
 * and only like-for-like bases are ranked against each other.
 */
export type PriceBasis = 'total' | 'per-day' | 'unknown';

/** One priced option scraped from a results page, e.g. "Compact — $184.22". */
export interface Offer {
  /** Car class or room name when the page exposes one. */
  label: string | null;
  amount: number;
  currency: string;
  basis: PriceBasis;
}

/**
 * Why a quote produced no price, as a value rather than a sentence.
 *
 * `status` collapsed five genuinely different outcomes into `no-price`, and the
 * only thing telling them apart was the English in `message` — which the popup
 * printed verbatim and nothing could count, group or reason about. "It said no
 * results for Hertz" was unanswerable without sitting next to the user.
 */
export type QuoteFailure =
  /** buildDeepLink refused — an unsearchable vendor, or a malformed trip. */
  | 'link-build'
  /** chrome.tabs.create failed, so the page was never even requested. */
  | 'tab-open'
  /** The background's own clock ran out; the probe never answered at all. */
  | 'probe-timeout'
  /** The probe polled to its deadline and never saw a price. */
  | 'probe-empty'
  /** extractOffers threw on this page's markup. */
  | 'extract-threw'
  /** The user closed the tab mid-probe. */
  | 'tab-closed'
  /** MV3 suspended the worker mid-race. */
  | 'interrupted'
  | 'cancelled';

/**
 * What the probe saw, kept whether or not it found a price.
 *
 * A deep link that lands on the vendor's home page still yields a plausible
 * "from $19/day" and reports `ok`, indistinguishable from a real quote. These
 * are the facts that tell the two apart after the fact — README calls the deep
 * links reverse-engineered and expected to rot, so the evidence has to survive
 * the run.
 */
export interface ProbeReport {
  /** Landed URL, path only — the query string carries the code and itinerary. */
  finalPath: string;
  title: string;
  offerCount: number;
  /** Which extraction branch produced the offers. */
  path: 'vendor-selectors' | 'generic-sweep';
}

export interface Quote {
  /** Stable per-run id: `${vendor}:${code}`. */
  id: string;
  candidate: Candidate;
  url: string;
  /** How much to trust the deep link that produced `url`. */
  confidence: LinkConfidence;
  status: QuoteStatus;
  offers: Offer[];
  /** Cheapest offer on the page, or null until one is found. */
  best: Offer | null;
  /**
   * Machine-readable reason. Usually set once a quote stops, but deliberately
   * absent when a content script reported something we do not recognise —
   * naming a specific failure there would be inventing one. Treat it as
   * optional and fall back to `message`.
   */
  failure?: QuoteFailure;
  /** Human detail. The only diagnosis when `failure` is absent. */
  message?: string;
  /** What the probe observed, when it got far enough to observe anything. */
  report?: ProbeReport;
  /** Set when the evidence says this page is not the search we asked for. */
  suspect?: 'landed-elsewhere';
  /** Paired with finishedAt to show how long a vendor took to answer. */
  startedAt?: number;
  finishedAt?: number;
}

export interface SearchPlan {
  trip: Trip;
  candidates: Candidate[];
  /** How many vendor tabs may load at once. Kept low to stay polite. */
  concurrency: number;
}

export interface RunState {
  plan: SearchPlan;
  quotes: Quote[];
  finishedAt?: number;
}
