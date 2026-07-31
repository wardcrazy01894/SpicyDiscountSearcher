import type { Offer, PriceBasis, VendorId } from './types.js';

/**
 * Reads prices off a vendor's results page.
 *
 * Every vendor renders its results differently and reshuffles the markup
 * without notice, so this works in two layers: a per-vendor selector config
 * when we know the structure, and a generic sweep that just looks for currency
 * amounts when we don't. The generic path is what keeps the extension useful
 * the day a vendor ships a redesign.
 */

/**
 * Currency markers, longest first so the alternation cannot settle for a
 * prefix. `CA$150` read as USD because a bare `\$` matched inside it, and a
 * Canadian dollar filed as USD buckets with real US prices and wins on face
 * value — the cross-currency comparison the bucketing exists to prevent,
 * arriving inside a single bucket where nothing downstream can see it.
 */
const CURRENCY = String.raw`CA\$|NZ\$|US\$|A\$|C\$|R\$|\$|€|£|USD|EUR|GBP|CAD|AUD|NZD`;

/**
 * A number as a price is written.
 *
 * Space-grouped forms ("1 234,56") come first, and must carry a decimal part.
 * Letting the digit class span whitespace read "From $59 2 seats" as 592, and
 * merely requiring three following digits still read "$59 250 vehicles" as
 * 59250 — both inventing prices the page never showed. Real space-grouped
 * money writes its cents; prose that happens to follow a price does not.
 *
 * The separator class covers the narrow no-break space too: that is what
 * Intl.NumberFormat('fr-FR') actually emits, so a French page's "1 234,56 €"
 * would otherwise fall through to the plain branch and read as 234.56 — a
 * thousand euros cheaper than the page said, which wins every race it enters.
 */
const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+[.,]\d{1,2}|\d[\d.,]*\d|\d`;

/** $1,234.56 · USD 89 · €99,50 · 1 234,56 € */
const PRICE_RE = new RegExp(
  `(?:(${CURRENCY})\\s*(${NUMBER}))|(?:(${NUMBER})\\s*(${CURRENCY}))`,
  'gi',
);

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  USD: 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
  CA$: 'CAD',
  C$: 'CAD',
  CAD: 'CAD',
  A$: 'AUD',
  AUD: 'AUD',
  NZ$: 'NZD',
  NZD: 'NZD',
  R$: 'BRL',
};

// A rental or hotel stay below this is almost certainly a fee, a tax line, or a
// "$0 due now" badge rather than a rate; above it is a phone number or an id.
const MIN_PLAUSIBLE = 5;
const MAX_PLAUSIBLE = 100_000;

export interface VendorSelectors {
  /** Scope the sweep to the results area, skipping nav and footer noise. */
  container?: string;
  /** One element per bookable option. */
  offer?: string;
  /** Car class / room name, relative to the offer element. */
  label?: string;
  /** Price, relative to the offer element. */
  price?: string;
}

/**
 * Known page structures. These are starting points captured from the public
 * booking flows; when a vendor redesigns, fix the selector here and the generic
 * fallback keeps working in the meantime.
 */
export const VENDOR_SELECTORS: Partial<Record<VendorId, VendorSelectors>> = {
  hertz: { container: '[data-testid="vehicle-list"], .vehicle-list, main' },
  avis: { container: '[data-testid="vehicle-results"], .car-results, main' },
  budget: { container: '[data-testid="vehicle-results"], .car-results, main' },
  enterprise: { container: '.car-class-list, [data-testid="vehicle-list"], main' },
  national: { container: '.car-class-list, [data-testid="vehicle-list"], main' },
  sixt: { container: '[data-testid="offer-list"], .offer-list, main' },
  hilton: { container: '[data-testid="hotel-card-list"], .hotel-results, main' },
  marriott: { container: '[data-testid="property-card-list"], .property-records, main' },
  hyatt: { container: '[data-testid="hotel-list"], .hotel-list, main' },
};

/** Does a lone separator group thousands ("1,234") rather than mark decimals? */
function groupsThousands(cleaned: string, separator: ',' | '.'): boolean {
  const escaped = separator === '.' ? '\\.' : ',';
  return new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(cleaned);
}

/** Turn "1,234.56" or "1.234,56" into a number, or null if it isn't one. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '');
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present, so the rightmost one has to be the decimal separator.
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(/,/g, '.') // European: 1.234,56
        : cleaned.replace(/,/g, ''); // US: 1,234.56
  } else if (lastComma >= 0 || lastDot >= 0) {
    // Only one kind of separator, which is genuinely ambiguous: "1,234" is a
    // thousand and "99,50" is ninety-nine fifty. Grouping is the only reading
    // where every group is exactly three digits, so test for that rather than
    // assuming — guessing wrong turns $1,234 into $1.234 and drops the price
    // below MIN_PLAUSIBLE, reporting "no usable price" for a page that had one.
    const separator = lastComma >= 0 ? ',' : '.';
    normalized = groupsThousands(cleaned, separator)
      ? cleaned.split(separator).join('')
      : cleaned.replace(separator, '.');
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const PER_UNIT_RE = /\b(per|\/)\s*(day|night|nt|día|nacht)\b|\bdaily\b|\bnightly\b|\/day|\/night/;
const TOTAL_RE = /\btotal\b|\bestimated total\b|\btrip total\b|\ball[- ]in\b|\bfor \d+ (day|night)/;

/** Words for a component of the bill, rather than a price for the thing. */
const FEE_NOUN = String.raw`taxes?|fees?|savings?|discounts?|surcharges?|deposits?|vat|gst`;

/**
 * The line has to *lead* with one — "$412 incl. taxes" is a price.
 *
 * The optional prefixes are the words hotels put in front of a fee: "Resort
 * fee", "Cleaning fee", "Destination fee". Without them the fee noun is not
 * first and the line reads as a rate.
 */
const FEE_PREFIX = String.raw`estimated|total|resort|service|cleaning|facility|destination|amenity|booking|admin(?:istration)?`;
const FEE_LEAD_RE = new RegExp(
  String.raw`^\s*(?:(?:${FEE_PREFIX})\s+){0,2}(?:${FEE_NOUN})\b|^\s*(?:you\s+)?saves?\b`,
  'i',
);

/** Words that turn a fee noun into a modifier on a real price. */
const INCLUSIVE_RE = /\b(?:includ\w*|incl\.?|inclusive|waived|covered|free)\b/i;

/** Every fee phrase, so what is left can be asked what it describes. */
const FEE_PHRASE_RE = new RegExp(
  String.raw`(?:(?:${FEE_PREFIX})\s+){0,2}(?:${FEE_NOUN})\b|\b(?:you\s+)?saves?\b`,
  'gi',
);

/**
 * Is this element's text a fee line rather than a price for something bookable?
 *
 * "Total taxes and fees: $57.20" carries the word `total`, so it was tagged
 * `total` and — being the cheapest number on that basis — became the page's
 * headline price. The popup announced a hotel at $57.20 and reported it as 88%
 * under the priciest comparable code. Every downstream guard passed it, because
 * the number genuinely was in the reported bucket; bucketing cannot save you
 * from a number that was never a rate.
 *
 * Leading with a fee noun is necessary but nowhere near sufficient, and getting
 * that wrong destroys real prices: "Fees included — $412 total", "Deposit
 * waived · $210 total" and "Savings Rate $89/day" all lead with one and all
 * quote a genuine rate. So take the fee phrases out and ask what is left. If
 * something still says what the number means — a `total`, a `/day` — then the
 * fee words were a modifier and the number is the price. If nothing is left to
 * say, the fee phrase *was* the subject and the number is the fee.
 */
function isFeeLine(own: string): boolean {
  if (!FEE_LEAD_RE.test(own)) return false;
  // "Fees and taxes included: $412.00" is standard hotel copy for a real
  // all-in price, and carries no `total` for the test below to find. The
  // inclusive word is the tell that the fee nouns are modifying a rate rather
  // than naming the number.
  if (INCLUSIVE_RE.test(own)) return false;
  const withoutFeeWords = own.replace(FEE_PHRASE_RE, ' ');
  return classifyBasis(withoutFeeWords) === 'unknown';
}

/**
 * Does this text describe two different kinds of number at once?
 *
 * "$29 per day, estimated total $210 for 3 days" cannot classify either one, so
 * both come back `unknown` — and `unknown` outranks `per-day` in
 * BASIS_PREFERENCE, so the daily rate becomes the page's headline price and
 * buckets with real trip totals. A wrapper holding several prices and both
 * signals is describing its children, not itself.
 */
function mixesBases(text: string): boolean {
  const lower = text.toLowerCase();
  return PER_UNIT_RE.test(lower) && TOTAL_RE.test(lower);
}

/**
 * Decide whether a number is a trip total or a nightly/daily rate.
 *
 * Text carrying *both* signals ("$29/day … Estimated total $210") describes two
 * different numbers, so it cannot classify either one — saying "per-day"
 * because that pattern was tested first is how a real total gets tagged as a
 * daily rate and wins a race it should have lost.
 */
export function classifyBasis(context: string): PriceBasis {
  const text = context.toLowerCase();
  const perUnit = PER_UNIT_RE.test(text);
  const total = TOTAL_RE.test(text);
  if (perUnit && total) return 'unknown';
  if (perUnit) return 'per-day';
  if (total) return 'total';
  return 'unknown';
}

export function findPrices(text: string): Array<{ amount: number; currency: string }> {
  const found: Array<{ amount: number; currency: string }> = [];
  for (const match of text.matchAll(PRICE_RE)) {
    const symbol = (match[1] ?? match[4] ?? '').toUpperCase();
    const digits = match[2] ?? match[3] ?? '';
    const amount = parseAmount(digits);
    if (amount === null || amount < MIN_PLAUSIBLE || amount > MAX_PLAUSIBLE) continue;
    found.push({ amount, currency: SYMBOL_TO_CURRENCY[symbol] ?? 'USD' });
  }
  return found;
}

function textOf(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function firstMatch(root: ParentNode, selector: string | undefined): Element | null {
  if (!selector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null; // A selector typo shouldn't take the whole extraction down.
  }
}

function allMatches(root: ParentNode, selector: string | undefined): Element[] {
  if (!selector) return [];
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

function dedupe(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const offer of offers) {
    const key = `${offer.label ?? ''}|${offer.amount}|${offer.currency}|${offer.basis}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(offer);
  }
  return out;
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, [data-testid*="name" i]';

interface PriceSite {
  element: Element;
  own: string;
  prices: Array<{ amount: number; currency: string }>;
  /**
   * Why this site is recorded but never emitted, or null if it is a real offer.
   *
   * Still a site either way, so it claims its number away from the card around
   * it. Dropping the element outright instead left the number unclaimed, and
   * the enclosing card — whose own text is short enough to be a site in its own
   * right — picked it up as if it were a rate. Excluding a number means making
   * sure nobody else takes it.
   */
  suppressed: 'fee-line' | 'mixed-basis' | null;
}

/**
 * Document-level containers, where the text stops describing any one offer.
 *
 * Deliberately not nav/header/footer/aside: inside a results container those
 * are *card* furniture — `<header>Nightly rate <span>$132.00</span></header>`
 * is the element that labels the rate — and breaking on the tag threw that
 * label away, leaving a per-night price `unknown`. `unknown` outranks
 * `per-day`, so it then landed in the same bucket as real trip totals and
 * crowned one night over a whole trip. Furniture inside the container needs a
 * containment test, not a tag test.
 */
const CHROME_SELECTOR = 'body, html, main';

/** Was-prices: struck through means the customer is not being charged it. */
const STRUCK_SELECTOR = 's, del, strike';

/** Characters that can be part of a number, for the separator rule below. */
const NUMERIC_EDGE = /[\d.,]/;

/**
 * An element's text with struck-through descendants left out.
 *
 * Built by walking children rather than by subtracting the struck string from
 * the full text: `$1,250.00 was <s>250.00</s>` would have had its *first*
 * "250.00" removed — the live price — leaving "$1, was" and dropping the
 * vendor out of the race entirely.
 *
 * Element boundaries get a space so `$132.00<span>per night</span>` still
 * reads as two words, but not between two number-ish characters: sites split
 * prices across elements for styling, and `$<span>12</span>,<span>500</span>`
 * turned into "$ 12 , 500" reads as $12 — a price that wins every race.
 */
function offerText(element: Element): string {
  // Only a genuine leaf can skip the walk. The old fast path took textContent
  // whenever nothing struck sat below, which is almost every element — so the
  // element-boundary space this function exists to insert was applied only
  // when an unrelated <s> happened to be present. Minified markup like
  // `<div class="rate">$132.00<span>per night</span></div>` read as
  // "$132.00per night", classified `unknown`, and a nightly rate landed in the
  // same bucket as real trip totals. Adding a struck-through was-price
  // elsewhere in the card changed the answer for the identical rate.
  if (element.children.length === 0) return textOf(element);

  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    if (child.matches(STRUCK_SELECTOR)) continue;

    const chunk = offerText(child);
    if (!chunk) continue;
    const joinsDigits = NUMERIC_EDGE.test(text.slice(-1)) && NUMERIC_EDGE.test(chunk[0]!);
    text += joinsDigits ? chunk : ` ${chunk}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every element whose own text reads as a price, in document order.
 *
 * Struck-through numbers are excluded: a was-price tagged `total` beats the
 * real price sitting beside it.
 */
function priceSites(root: Element): PriceSite[] {
  const sites: PriceSite[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.closest(STRUCK_SELECTOR)) continue;

    // Only elements whose own text is short — a price lives in a leaf, while a
    // container's textContent would sweep the whole page into one match.
    //
    // 80 rather than 40: "Estimated total $412.00 including taxes and fees" is
    // 47 characters, so the commonest wording for the single most valuable
    // number on the page was dropped entirely and the quote came back
    // `probe-empty`. Which vendors got ranked then depended on how verbose
    // their card copy happened to be. A real container's text still runs to
    // hundreds of characters, so the cap keeps doing its job.
    const own = offerText(element);
    if (!own || own.length > 80) continue;

    const prices = findPrices(own);
    if (prices.length === 0) continue;
    // A line that leads with a fee word and holds more than one number cannot
    // be split by text alone: "Save $50 · $412 total" is a savings badge and a
    // real total sharing an element, and emitting both makes the $50 a `total`
    // that wins the race outright. Suppressing both can instead cost the $412 —
    // but only when no other element on the card quotes it, and a lost price
    // drops a vendor out of the running while a wrong one crowns it. Take the
    // trade in that direction, deliberately.
    const suppressed =
      isFeeLine(own) || (FEE_LEAD_RE.test(own) && prices.length > 1)
        ? 'fee-line'
        : prices.length > 1 && mixesBases(own)
          ? 'mixed-basis'
          : null;
    sites.push({ element, own, prices, suppressed });
  }

  // However the amount is wrapped. Vendors put the number in a span to style
  // it — `<div class="fees">Total taxes and fees: <span>$57.20</span></div>` —
  // and that span's own text is just "$57.20", which reads as a perfectly good
  // price. Flagging only the element whose text carries the words left the
  // headline bug entirely intact in the commonest markup there is: the span
  // emitted, and basisFor then climbed to the fee div and tagged it `total`.
  const feeElements = sites.filter((s) => s.suppressed === 'fee-line').map((s) => s.element);
  for (const site of sites) {
    if (site.suppressed) continue;
    if (feeElements.some((fee) => fee !== site.element && fee.contains(site.element))) {
      site.suppressed = 'fee-line';
    }
  }
  return sites;
}

/** Multiset difference on (amount, currency). */
function without(
  prices: ReadonlyArray<{ amount: number; currency: string }>,
  taken: ReadonlyArray<{ amount: number; currency: string }>,
): Array<{ amount: number; currency: string }> {
  const remaining = [...prices];
  for (const price of taken) {
    const index = remaining.findIndex(
      (candidate) => candidate.amount === price.amount && candidate.currency === price.currency,
    );
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/**
 * Heading text inside (or being) this node, if it reads like a class name.
 *
 * Memoised per element: on a page whose cards carry no headings the walk
 * reaches the results list and scans every card, once per price. Caching turns
 * that from a per-price cost into a per-node one.
 */
function headingText(node: Element, cache: Map<Element, string | null>): string | null {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const heading = node.matches(HEADING_SELECTOR) ? node : node.querySelector(HEADING_SELECTOR);
  const text = heading ? textOf(heading) : '';
  const usable = text && text.length <= 80 && findPrices(text).length === 0 ? text : null;
  cache.set(node, usable);
  return usable;
}

/** How many earlier siblings to search before giving up at a nesting level. */
const SIBLING_REACH = 4;

/**
 * Nearest heading-ish text above a price, used as the car class / room name.
 *
 * Walks outwards from the number — own subtree, then earlier siblings nearest
 * first, then up a level — rather than calling querySelectorAll on each
 * ancestor. That returned the *first* heading in the subtree, so on a list of
 * cards every price came back labelled with card one's class, feeding
 * classMatrix the very mismatch it exists to detect. Scanning outwards is also
 * what keeps this linear: the old form re-scanned the whole results list once
 * per price per ancestor level, which measured in seconds on a long hotel page.
 *
 * Known limit: a card with no heading of its own inherits the previous card's.
 * Markup cannot tell us otherwise — `<div class="hdr"><h3>Economy</h3><span>
 * from $29/day</span></div>` beside that card's real total is structurally
 * identical to two sibling offer cards — and every rule that rejected the
 * second also rejected the first, stripping labels from the commonest card
 * markup there is and leaving classMatrix nothing to compare. An occasional
 * borrowed label beats no labels at all.
 */
function labelNear(
  element: Element,
  cache: Map<Element, string | null>,
  root: Element,
): string | null {
  let node: Element | null = element;
  for (let depth = 0; node && depth < 5; depth += 1) {
    // Stop before the results container itself. headingText() runs
    // querySelector over whatever node it is given, so once the walk reached
    // the container it returned the first heading on the entire results list —
    // handing a promo banner ("Weekend deals from $19/day") the first card's
    // class. That price then beat every real rate AND looked comparable to
    // them, so classMatrix saw the winner leading its own class and stayed
    // silent. A wrong label here defeats the check meant to catch it.
    //
    // The container is a label for all the cards or none of them, so it can
    // never be the *nearest* heading to one price in particular.
    if (node !== element && (node === root || node.matches(CHROME_SELECTOR))) break;

    const own = headingText(node, cache);
    if (own) return own;

    let reach = 0;
    for (
      let prev = node.previousElementSibling;
      prev && reach < SIBLING_REACH;
      prev = prev.previousElementSibling, reach += 1
    ) {
      const text = headingText(prev, cache);
      if (text) return text;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * What one number on the page means. Read outwards from the number itself — its
 * own text, then its immediate neighbours, then the card around it — and stop
 * at the first level that says something unambiguous.
 *
 * Classifying from the card alone is what tagged a whole "$29/day … Estimated
 * total $210" card as per-day, emptying the totals bucket so the daily rate
 * became the headline price.
 */
function basisFor(
  element: Element,
  own: string,
  pricesAtOrBelow: ReadonlyMap<Element, Set<string>>,
  root: Element,
): PriceBasis {
  const local = classifyBasis(own);
  if (local !== 'unknown') return local;

  // A sibling carrying a price of its own is a different offer: in a list of
  // cards the previous sibling *is* the previous card, and reading its
  // "$29/day" tagged this card's total as a daily rate, which the popup then
  // multiplied into a fabricated week-long estimate. A sibling with no price
  // is a label for ours — the "Estimated total" next to "$210.00" — and
  // rejecting those by card identity left real totals classified `unknown`,
  // splitting them out of the race they belonged in.
  const describes = (node: Element | null): string =>
    node && !pricesAtOrBelow.has(node) ? textOf(node) : '';

  const nearby = classifyBasis(
    [describes(element.previousElementSibling), own, describes(element.nextElementSibling)].join(
      ' ',
    ),
  );
  if (nearby !== 'unknown') return nearby;

  // Climb until something is decisive, rather than asking one ancestor.
  //
  // Asking one ancestor via closest('li, article, section, tr, div') matched
  // on `div`, so for
  // `<div class=pr><div class=l>Estimated total</div><div class=a><span>$367</span></div></div>`
  // it stopped at `div.a` — whose text is just the number — and called a real
  // total `unknown`, splitting it out of the race it belonged in. Climbing
  // reaches `div.pr` and reads "Estimated total $367.00".
  //
  // The climb stops at the first ancestor holding a price that is not ours,
  // because from there outwards the text is describing somebody else: a `<ul>`
  // of cards reads as "/day" purely because the card next door carries a
  // daily-rate badge.
  //
  // Comparing *prices* rather than counting sites is what makes that safe. A
  // wrapper like `<div class=rate><span>$132.00</span>/night</div>` is a price
  // site in its own right holding the very same number, so counting made it
  // look foreign and threw away the one element that actually labelled the
  // rate — which then let a distant "Estimated total" claim a resort fee.
  const ours = pricesAtOrBelow.get(element) ?? new Set<string>();
  let node: Element | null = element.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1) {
    // Never climb out of the results container. pricesAtOrBelow only knows
    // about prices found inside it, so beyond that edge the climb can read
    // page chrome — a nav link saying "Total price guarantee" — while no
    // price out there is able to stop it. A nightly rate tagged `total` from
    // site furniture is exactly the mixed-basis ranking this all exists to
    // prevent.
    if (!root.contains(node)) break;
    // Nor into page-level containers. When no vendor selector matches, root is
    // <body>, and body.contains(body) is true — so the bound above alone still
    // let a nav link reading "Total price guarantee" classify a nightly rate.
    if (node.matches(CHROME_SELECTOR)) break;
    for (const price of pricesAtOrBelow.get(node) ?? []) {
      if (!ours.has(price)) return 'unknown';
    }
    const wider = classifyBasis(textOf(node));
    if (wider !== 'unknown') return wider;
    node = node.parentElement;
  }
  return 'unknown';
}

/**
 * Which of a site's prices also appear in a descendant site.
 *
 * Walking each site's ancestor chain once is O(sites × depth); comparing every
 * site against every other was O(sites²), which measured at five seconds on a
 * long hotel results list.
 */
function claimedByDescendants(
  sites: readonly PriceSite[],
): Map<PriceSite, Array<{ amount: number; currency: string }>> {
  const byElement = new Map<Element, PriceSite>(sites.map((site) => [site.element, site]));
  const claimed = new Map<PriceSite, Array<{ amount: number; currency: string }>>();

  for (const site of sites) {
    for (let parent = site.element.parentElement; parent; parent = parent.parentElement) {
      const owner = byElement.get(parent);
      if (!owner) continue;
      const existing = claimed.get(owner);
      if (existing) existing.push(...site.prices);
      else claimed.set(owner, [...site.prices]);
    }
  }
  return claimed;
}

/**
 * Generic sweep: walk leaf-ish elements, take any that read as a price, and
 * borrow a label from the nearest heading that plausibly titles it.
 */
function sweep(root: Element): Offer[] {
  const sites = priceSites(root);
  const claimed = claimedByDescendants(sites);
  // Which distinct prices sit at or below each element. Precomputed because
  // asking "does this node cover a price other than mine?" per price per
  // ancestor was quadratic, which measured in seconds on a long results list.
  const pricesAtOrBelow = new Map<Element, Set<string>>();
  for (const site of sites) {
    const keys = site.prices.map((price) => `${price.amount}|${price.currency}`);
    for (let node: Element | null = site.element; node; node = node.parentElement) {
      const seen = pricesAtOrBelow.get(node) ?? new Set<string>();
      for (const key of keys) seen.add(key);
      pricesAtOrBelow.set(node, seen);
    }
  }
  const headings = new Map<Element, string | null>();
  const offers: Offer[] = [];

  for (const site of sites) {
    // A price that also turns up in a descendant belongs to the descendant —
    // that element sits closest to the number, so its label and basis are the
    // specific ones. Only the remainder is this element's own. Dropping
    // containers wholesale instead lost any price written as a text node
    // beside a nested badge ("Est. total $210.00 <span>+$18.00 fees</span>"),
    // handing the ranker the fee as if it were the trip total.
    // Recorded above only so it could claim its numbers away from the card.
    if (site.suppressed) continue;

    const mine = without(site.prices, claimed.get(site) ?? []);
    if (mine.length === 0) continue;

    const label = labelNear(site.element, headings, root);
    const basis = basisFor(site.element, site.own, pricesAtOrBelow, root);
    for (const price of mine) {
      offers.push({ label, amount: price.amount, currency: price.currency, basis });
    }
  }

  return dedupe(offers);
}

/**
 * Offers plus which branch found them.
 *
 * CLAUDE.md says a vendor redesign should degrade to the generic sweep rather
 * than to nothing — but degrading silently is indistinguishable from a vendor
 * whose selectors were never written. Recording the branch makes "this vendor
 * used to match its selectors and now never does" answerable from one report.
 */
export interface Extraction {
  offers: Offer[];
  path: 'vendor-selectors' | 'generic-sweep';
}

export function extract(doc: Document, vendor: VendorId): Extraction {
  const config = VENDOR_SELECTORS[vendor] ?? {};
  const root = firstMatch(doc, config.container) ?? doc.body;
  // No root at all: nothing ran, and the sweep is the honest default only
  // because it is the branch that would have run.
  if (!root) return { offers: [], path: 'generic-sweep' };

  const offerNodes = allMatches(root, config.offer);
  if (offerNodes.length > 0) {
    const offers: Offer[] = [];
    const headings = new Map<Element, string | null>();
    for (const node of offerNodes) {
      const label = textOf(firstMatch(node, config.label)) || labelNear(node, headings, root);
      const priceText = textOf(firstMatch(node, config.price)) || textOf(node);
      const context = textOf(node).slice(0, 400);
      for (const price of findPrices(priceText)) {
        offers.push({
          label: label || null,
          amount: price.amount,
          currency: price.currency,
          basis: classifyBasis(context),
        });
      }
    }
    if (offers.length > 0) return { offers: dedupe(offers), path: 'vendor-selectors' };
  }

  return { offers: sweep(root), path: 'generic-sweep' };
}

export function extractOffers(doc: Document, vendor: VendorId): Offer[] {
  return extract(doc, vendor).offers;
}

const BASIS_PREFERENCE: PriceBasis[] = ['total', 'unknown', 'per-day'];

/**
 * The headline number for a page: cheapest offer on the most trustworthy basis
 * available, in the currency that page mostly quotes. Totals beat unlabelled
 * numbers, which beat per-day rates, so a vendor advertising "$29/day" never
 * appears to undercut a rival's real total — and a converted "€150" shown
 * beside a "$210" total is not taken for the cheaper of the two.
 */
export function bestOffer(offers: Offer[]): Offer | null {
  for (const basis of BASIS_PREFERENCE) {
    const matching = offers.filter((o) => o.basis === basis);
    if (matching.length === 0) continue;

    const counts = new Map<string, number>();
    for (const offer of matching) {
      counts.set(offer.currency, (counts.get(offer.currency) ?? 0) + 1);
    }
    let currency = matching[0]!.currency;
    for (const [candidate, count] of counts) {
      if (count > (counts.get(currency) ?? 0)) currency = candidate;
    }

    return matching
      .filter((o) => o.currency === currency)
      .reduce((best, o) => (o.amount < best.amount ? o : best));
  }
  return null;
}
