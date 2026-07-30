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

/** $1,234.56 · USD 89 · €99,50 · 1 234,56 € */
const PRICE_RE =
  /(?:(US\$|\$|€|£|USD|EUR|GBP)\s*([0-9][0-9.,\s]*[0-9]|[0-9]))|(?:([0-9][0-9.,\s]*[0-9]|[0-9])\s*(US\$|\$|€|£|USD|EUR|GBP))/gi;

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  USD: 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
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

/** Turn "1,234.56" or "1.234,56" into a number, or null if it isn't one. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '');
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;

  if (lastComma > lastDot) {
    // European style: dots group thousands, comma is the decimal separator.
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/[.,]/g, '');
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Decide whether a number is a trip total or a nightly/daily rate. */
export function classifyBasis(context: string): PriceBasis {
  const text = context.toLowerCase();
  if (/\b(per|\/)\s*(day|night|nt|día|nacht)\b|\bdaily\b|\bnightly\b|\/day|\/night/.test(text)) {
    return 'per-day';
  }
  if (
    /\btotal\b|\bestimated total\b|\btrip total\b|\ball[- ]in\b|\bfor \d+ (day|night)/.test(text)
  ) {
    return 'total';
  }
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

/**
 * Generic sweep: walk leaf-ish elements, take any that read as a price, and
 * borrow a label from the nearest ancestor that also holds a heading.
 */
function sweep(root: ParentNode): Offer[] {
  const offers: Offer[] = [];
  const elements = [...root.querySelectorAll<HTMLElement>('*')];

  for (const element of elements) {
    // Only consider elements whose own text is short — a price lives in a leaf,
    // while a container's textContent would sweep the whole page into one match.
    const own = textOf(element);
    if (!own || own.length > 40) continue;

    const prices = findPrices(own);
    if (prices.length === 0) continue;

    const context = textOf(element.closest('li, article, section, tr, div') ?? element).slice(
      0,
      400,
    );
    const label = labelNear(element);

    for (const price of prices) {
      offers.push({
        label,
        amount: price.amount,
        currency: price.currency,
        basis: classifyBasis(context || own),
      });
    }
  }

  return dedupe(offers);
}

/** Nearest heading-ish text above a price, used as the car class / room name. */
function labelNear(element: Element): string | null {
  let node: Element | null = element;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const heading = node.querySelector('h1, h2, h3, h4, h5, [data-testid*="name" i]');
    const text = textOf(heading);
    if (text && text.length <= 80 && findPrices(text).length === 0) return text;
    node = node.parentElement;
  }
  return null;
}

export function extractOffers(doc: Document, vendor: VendorId): Offer[] {
  const config = VENDOR_SELECTORS[vendor] ?? {};
  const root = firstMatch(doc, config.container) ?? doc.body;
  if (!root) return [];

  const offerNodes = allMatches(root, config.offer);
  if (offerNodes.length > 0) {
    const offers: Offer[] = [];
    for (const node of offerNodes) {
      const label = textOf(firstMatch(node, config.label)) || labelNear(node);
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
    if (offers.length > 0) return dedupe(offers);
  }

  return sweep(root);
}

const BASIS_PREFERENCE: PriceBasis[] = ['total', 'unknown', 'per-day'];

/**
 * The headline number for a page: cheapest offer on the most trustworthy basis
 * available. Totals beat unlabelled numbers, which beat per-day rates, so a
 * vendor advertising "$29/day" never appears to undercut a rival's real total.
 */
export function bestOffer(offers: Offer[]): Offer | null {
  for (const basis of BASIS_PREFERENCE) {
    const matching = offers.filter((o) => o.basis === basis);
    if (matching.length === 0) continue;
    return matching.reduce((best, o) => (o.amount < best.amount ? o : best));
  }
  return null;
}
