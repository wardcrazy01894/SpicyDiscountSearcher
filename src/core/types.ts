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
  /**
   * How long a quote at this vendor may take, if the default is not enough.
   *
   * Exists for Enterprise, whose booking widget is not merely slow but
   * *variably* slow: it mounted instantly on one profile, took about forty
   * seconds on another, and on a third never mounted at all. The default 45s
   * budget, of which a driver gets `DRIVE_SHARE`, cannot absorb that.
   *
   * Per-vendor rather than a raised global, because the global is also a
   * politeness setting: it bounds how long a tab sits open on *every* vendor's
   * site, and Hertz, Avis and National answer well inside it. Slowing them down
   * to accommodate Enterprise would be paying for one vendor's problem
   * everywhere.
   *
   * `KEEPALIVE_CEILING_MS` is **not** derived from these — it stays on the
   * default, and that was checked rather than assumed. Its job is to exceed the
   * longest legitimate gap between two quotes settling, and `13 x (45s + 750ms)`
   * is 9.9 minutes against a 120s quote: five times over. Deriving it from the
   * largest instead pushed it to 26 minutes, which is how long a *wedged* run
   * would pin the worker with a minimised window open. See the constant's own
   * comment; there is room for a vendor budget of about eight minutes before
   * this stops being true.
   */
  probeTimeoutMs?: number;
  /**
   * How many tabs may be open at this vendor at once, if fewer than the run's
   * own concurrency.
   *
   * For sites that keep the search in session state rather than in the URL.
   * National is the measured case: reloading its form showed the previous
   * search's location, dates *and* account number still in place, and tabs in
   * one profile share that state — so two lanes racing two codes can settle on
   * one, and the result is one company's price reported under another's code.
   *
   * A cap rather than a boolean because "one" is the only value anyone needs
   * today but is not obviously the only value anyone will ever need, and a
   * number costs nothing extra to honour.
   *
   * Absent means no vendor-specific limit; the run's concurrency is the only
   * bound.
   */
  maxLanes?: number;
  /**
   * This vendor's form does not mount unless Chrome actually paints the tab.
   *
   * The probe window is minimised, and a minimised window is never painted — so
   * for a vendor with this flag the window is opened *visible* (never focused)
   * and minimised again as soon as the driver reports the form has mounted, via
   * `DriveContext.hydrated`.
   *
   * Enterprise is the measured case, and it is not throttling or
   * `visibilityState`. A hidden tab left for 153 seconds had **zero `<input>`
   * elements** while the page shell rendered normally; one forced repaint
   * produced all five and `#cid` immediately, with `visibilityState` still
   * `hidden` and timers running at the documented ~1/s throughout. The standard
   * "hydrate when scrolled into view" pattern does exactly this, and no
   * content-script API can force a frame in a window Chrome is not drawing.
   *
   * Deliberately per-vendor and deliberately narrow. It is the one thing in
   * this file that puts a window on the user's screen, so it costs politeness
   * and must be paid only where it buys a vendor that otherwise cannot run at
   * all. Do not set it to make a slow vendor faster.
   */
  needsPaintedWindow?: boolean;
}

/** One discount code for one company at one vendor, as parsed from the workbook. */
export interface CodeRecord {
  vendor: VendorId;
  /**
   * Null when the workbook only gave a booking URL, e.g. Deloitte's Hilton
   * link. `buildCandidates` skips those records, so a URL-only row is
   * provenance the extension keeps and never surfaces — the booking link is
   * unreachable from the picker.
   */
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
  /**
   * The workbook's qualifier for this code — "Americas only", "Doubletree,
   * Embassy Suites only". Carried this far and then dropped: nothing renders
   * it, so the caveat the spreadsheet attached never reaches the user.
   */
  note: string | null;
}

export type QuoteStatus = 'pending' | 'loading' | 'ok' | 'no-price' | 'error' | 'cancelled';

/**
 * What a scraped number actually means. Comparing a nightly rate against a trip
 * total would silently pick the wrong winner, so every offer records its basis
 * and only like-for-like bases are ranked against each other.
 */
/**
 * `per-day` covers per-night too. Car-centric naming in a tool that ships
 * hotels, and every hotel-facing site undoes it — `perUnitLabel` translates it
 * to "/night", `basisPhrase` to "nightly rates", `tripUnits` to nights. Not
 * renamed, and the honest reason is churn rather than risk: three call sites
 * already translate it, and a rename touches every one plus the tests for the
 * sake of a word. Two earlier attempts at this comment claimed the value's
 * persistence in `chrome.storage.session` made a rename unsafe — it does not.
 * That store is in-memory and dies with the extension context, so any snapshot
 * in it was written by the build now reading it.
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
  /** `extract` threw on this page's markup. */
  | 'extract-threw'
  /**
   * A driver could not find or fill a field on the vendor's own search form.
   *
   * Separate from `extract-threw` because it fails at the opposite end: the
   * page was never asked for a price, so "no price appeared" would be a lie.
   */
  | 'form-fill'
  /** The form was filled, but submitting it never produced a results page. */
  | 'form-submit'
  /**
   * The vendor read the code and refused it, in its own words.
   *
   * Distinct from every other failure here because nothing is broken: the
   * search form worked, the submission worked, and the answer was no. National
   * and Enterprise both return "this account number cannot be used online.
   * Please contact your account manager" for some corporate accounts.
   *
   * **The only failure treated as durable.** It is a fact about the code rather
   * than about the run, and it is the vendor's own sentence rather than
   * anything this extension inferred — which is what makes it safe to remember
   * and stop retrying. See `rejected-codes.ts`.
   */
  | 'code-rejected'
  /**
   * The search ran, and came back without the corporate account applied.
   *
   * Deliberately *not* `code-rejected`, though a user might reasonably read the
   * two the same way. That one is the vendor speaking; this one is us failing
   * to find evidence the discount landed — National's results page naming no
   * account — which is equally consistent with the vendor silently ignoring the
   * code and with our own check having rotted against a redesign.
   *
   * The distinction is load-bearing precisely because rejections are
   * remembered: recording this one would let a broken selector quietly retire a
   * working code, permanently and invisibly.
   */
  | 'discount-missing'
  /**
   * The page priced a different trip from the one asked for.
   *
   * Not a missing price — a real one, for the wrong rental. Avis lets its
   * persisted booking widget outrank the query string, so a stale location
   * could render "Tampa Intl Airport (TPA) - Philadelphia Intl Airport (PHL)"
   * for a URL asking TPA to TPA. Only the page can see this, which is why the
   * probe may claim it.
   */
  | 'wrong-trip'
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
  /**
   * Which extraction branch produced the offers.
   *
   * The last two are the background's own knowledge and a content script may
   * never claim them — same doctrine as `QuoteFailure`, enforced the same way,
   * by an allowlist at ingest. A page that could say `not-reached` could forge
   * "the background observed this".
   *
   * `body-fallback` is `generic-sweep`'s unhappy twin and the distinction is
   * load-bearing: the sweep ran over `doc.body` because **no container this
   * vendor names was in the document**, so the prices below may have come from
   * anywhere on the page — a footer, a promo banner, a cross-sell. Hertz
   * reported $20,000 for every code that way, from a Car Sales advert outside
   * `<main>`. `generic-sweep` means the sweep ran inside the container and is
   * ordinary; this one means the scope was lost.
   *
   * `not-reached`: the probe never answered, so the background described the
   * tab instead. `left-our-origins`: it could not even do that, because the tab
   * had navigated somewhere this extension holds no permission to read — which
   * is also precisely when the content script stops running.
   */
  path: 'vendor-selectors' | 'generic-sweep' | 'body-fallback' | 'not-reached' | 'left-our-origins';
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
  /**
   * Evidence that arrived after the quote had already been settled.
   *
   * A page can finish parsing a millisecond inside the deadline and still send
   * after it. That reply used to be dropped on the floor — offers, best price
   * and report — while the quote kept a `probe-timeout` saying the tab never
   * answered. Recording it turns "no answer before the deadline" into "answered
   * too late", which are different problems with different fixes.
   */
  lateReport?: ProbeReport;
  /**
   * Set when the evidence says this price should not be ranked.
   *
   * `landed-elsewhere`: the page is not the search we asked for.
   * `scope-lost`: the price came from outside every container the vendor
   * names, so it may have been swept off a banner, a footer or a cross-sell
   * rather than a results card. Hertz reported $20,000 for every code that
   * way, from a Car Sales advert.
   *
   * Both keep the quote out of the ranking rather than merely badging it. That
   * distinction is the whole lesson of the `landedElsewhere` note in
   * CLAUDE.md — "Flagging alone was not enough", because `pricedOnly` filtered
   * on status and price, so the bad number still won and `savings` still
   * announced it.
   */
  suspect?: 'landed-elsewhere' | 'scope-lost';
  /** Paired with finishedAt to show how long a vendor took to answer. */
  startedAt?: number;
  finishedAt?: number;
}

/**
 * How many vendor tabs may load at once, ever.
 *
 * CLAUDE.md names this a politeness invariant and a test pins it — but only
 * the background's copy. It was written out three times (the worker's clamp,
 * the popup's clamp, and `max` on the number input), so raising the worker's
 * alone would have gone uncaught by the popup, and raising the popup's alone
 * would have shown the user a limit the worker refuses to honour.
 */
export const MAX_CONCURRENCY = 6;

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
