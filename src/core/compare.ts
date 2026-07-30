import type { Offer, PriceBasis, Quote, Trip } from './types.js';

/** A quote that came back with a usable price. */
export type PricedQuote = Quote & { best: Offer };

/**
 * Two quotes only answer the same question when they quoted the same *kind* of
 * number in the same currency. A "$29/day" badge and a "€219 trip total" are
 * different questions, and ranking them together is exactly how you crown a
 * loser: 29 < 219 while the real comparison is 203 vs 219 in one currency.
 */
export interface ComparisonGroup {
  basis: PriceBasis;
  currency: string;
  /** Cheapest first. */
  quotes: PricedQuote[];
}

/** Trip totals are the number we actually want; a daily rate is the last resort. */
const BASIS_RANK: Record<PriceBasis, number> = { total: 0, unknown: 1, 'per-day': 2 };

function pricedOnly(quotes: Quote[]): PricedQuote[] {
  return quotes.filter((q): q is PricedQuote => q.status === 'ok' && q.best !== null);
}

function groupKey(offer: Offer): string {
  return `${offer.basis}|${offer.currency}`;
}

/**
 * Split the priced quotes into like-for-like buckets, best first.
 *
 * A bucket holding a rival is a race; a bucket holding one quote is just a
 * number with nothing to beat. Among real races the more trustworthy basis
 * wins, which is what `bestOffer`'s preference order and CLAUDE.md both
 * promise — three codes quoting a daily rate should not demote two codes
 * quoting the real trip total into a footnote.
 */
export function comparisonGroups(quotes: Quote[]): ComparisonGroup[] {
  const buckets = new Map<string, ComparisonGroup>();

  for (const quote of pricedOnly(quotes)) {
    const key = groupKey(quote.best);
    const bucket = buckets.get(key) ?? {
      basis: quote.best.basis,
      currency: quote.best.currency,
      quotes: [],
    };
    bucket.quotes.push(quote);
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.quotes.sort((a, b) => a.best.amount - b.best.amount);
  }

  return [...buckets.values()].sort((a, b) => {
    const aRace = a.quotes.length > 1 ? 0 : 1;
    const bRace = b.quotes.length > 1 ? 0 : 1;
    return (
      aRace - bRace ||
      BASIS_RANK[a.basis] - BASIS_RANK[b.basis] ||
      b.quotes.length - a.quotes.length ||
      a.currency.localeCompare(b.currency)
    );
  });
}

/** The race we report on, or null if nothing priced. */
export function primaryGroup(quotes: Quote[]): ComparisonGroup | null {
  return comparisonGroups(quotes)[0] ?? null;
}

/** Priced quotes that sit outside the reported race, so the UI can say so. */
export function unrankedQuotes(quotes: Quote[]): PricedQuote[] {
  return comparisonGroups(quotes)
    .slice(1)
    .flatMap((group) => group.quotes);
}

export function cheapest(quotes: Quote[]): PricedQuote | null {
  return primaryGroup(quotes)?.quotes[0] ?? null;
}

/**
 * Full ranking for display: priced quotes first — grouped so like sits with
 * like and the leading bucket's cheapest is top — then everything still
 * working, then the ones that failed.
 */
export function rankQuotes(quotes: Quote[]): Quote[] {
  const statusRank: Record<Quote['status'], number> = {
    ok: 0,
    loading: 1,
    pending: 2,
    'no-price': 3,
    error: 4,
    cancelled: 5,
  };

  const bucketRank = new Map<string, number>();
  comparisonGroups(quotes).forEach((group, index) => {
    bucketRank.set(`${group.basis}|${group.currency}`, index);
  });
  const bucketOf = (quote: Quote): number =>
    quote.best ? (bucketRank.get(groupKey(quote.best)) ?? 0) : 0;

  return [...quotes].sort((a, b) => {
    const byStatus = statusRank[a.status] - statusRank[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.best && b.best) {
      return bucketOf(a) - bucketOf(b) || a.best.amount - b.best.amount;
    }
    return a.candidate.companyName.localeCompare(b.candidate.companyName);
  });
}

export interface Savings {
  /** Most expensive quote in the reported race — what picking badly costs. */
  worst: number;
  best: number;
  absolute: number;
  percent: number;
  /** Unit the spread is expressed in; every quote in the race shares it. */
  currency: string;
  basis: PriceBasis;
}

/**
 * What the winning code saved against the worst result *it can be compared
 * with*. Null until at least two codes land in the same bucket, because a
 * single price has nothing to beat and a mismatched one isn't a rival.
 */
export function savings(quotes: Quote[]): Savings | null {
  const group = primaryGroup(quotes);
  if (!group || group.quotes.length < 2) return null;

  const best = group.quotes[0]!.best.amount;
  const worst = group.quotes[group.quotes.length - 1]!.best.amount;
  if (worst <= 0) return null;

  return {
    best,
    worst,
    absolute: worst - best,
    percent: ((worst - best) / worst) * 100,
    currency: group.currency,
    basis: group.basis,
  };
}

/** Days since the epoch for an ISO yyyy-mm-dd date, or null if it isn't one. */
function isoDay(iso: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);

  const ms = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(ms)) return null;
  // Date.UTC rolls over silently — "2026-02-30" becomes March 2 — so a
  // malformed date would otherwise produce a plausible-looking wrong trip
  // length rather than no answer at all.
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ms / 86_400_000;
}

/**
 * Billable days (car) or nights (hotel) — what a per-day rate has to be
 * multiplied by to reach something comparable to a trip total. A car picked up
 * and dropped off the same day is still one billed day; a hotel stay that
 * doesn't span a night isn't a stay.
 */
export function tripUnits(trip: Trip): number | null {
  const [from, to] =
    trip.category === 'car' ? [trip.pickupDate, trip.dropoffDate] : [trip.checkIn, trip.checkOut];
  const start = isoDay(from);
  const end = isoDay(to);
  if (start === null || end === null) return null;

  const span = end - start;
  if (span > 0) return span;
  return trip.category === 'car' && span === 0 ? 1 : null;
}

/**
 * A daily rate expressed as a whole-trip estimate. Deliberately not stored on
 * the Offer: it is arithmetic we did, not a number any vendor showed us, and it
 * ignores the taxes and fees a real total carries — so it must always be
 * presented as an estimate and never fed back into ranking.
 */
export function estimatedTotal(offer: Offer, trip: Trip): number | null {
  if (offer.basis !== 'per-day') return null;
  const units = tripUnits(trip);
  return units === null ? null : offer.amount * units;
}

/**
 * Car classes and room names are written differently on every site
 * ("Compact SUV", "compact suv - or similar"), so collapse them to a
 * comparable key before lining prices up side by side.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\bor similar\b.*$/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MatrixRow {
  label: string;
  /** Quote id -> cheapest amount that quote offered for this class. */
  amounts: Map<string, number>;
  bestQuoteId: string | null;
  bestAmount: number | null;
}

/**
 * Line every code up against every car class or room type they share, so a code
 * that only wins because it surfaced a cheaper *class* is easy to spot.
 *
 * `within` restricts the matrix to one basis and currency, and is required
 * rather than optional: a fairness check computed from a daily rate on one
 * side and a trip total on the other is not a fairness check, and leaving the
 * guard opt-in invites the next caller to reintroduce exactly that.
 */
export function classMatrix(
  quotes: Quote[],
  within: { basis: PriceBasis; currency: string },
): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();

  for (const quote of quotes) {
    for (const offer of quote.offers) {
      if (!offer.label) continue;
      if (offer.basis !== within.basis || offer.currency !== within.currency) continue;
      const label = normalizeLabel(offer.label);
      if (!label) continue;
      const row = rows.get(label) ?? {
        label,
        amounts: new Map<string, number>(),
        bestQuoteId: null,
        bestAmount: null,
      };
      const existing = row.amounts.get(quote.id);
      if (existing === undefined || offer.amount < existing) {
        row.amounts.set(quote.id, offer.amount);
      }
      rows.set(label, row);
    }
  }

  for (const row of rows.values()) {
    for (const [quoteId, amount] of row.amounts) {
      if (row.bestAmount === null || amount < row.bestAmount) {
        row.bestAmount = amount;
        row.bestQuoteId = quoteId;
      }
    }
  }

  // Classes offered by the most codes first — those are the fair comparisons.
  return [...rows.values()].sort(
    (a, b) => b.amounts.size - a.amounts.size || a.label.localeCompare(b.label),
  );
}
