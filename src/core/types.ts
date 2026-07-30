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
  /** Workbook sheets that listed this code; more sources means more confidence. */
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

export interface Quote {
  /** Stable per-run id: `${vendor}:${code}`. */
  id: string;
  candidate: Candidate;
  url: string;
  status: QuoteStatus;
  offers: Offer[];
  /** Cheapest offer on the page, or null until one is found. */
  best: Offer | null;
  message?: string;
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
  runId: string;
  plan: SearchPlan;
  quotes: Quote[];
  startedAt: number;
  finishedAt?: number;
}
