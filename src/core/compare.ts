import type { Offer, Quote } from './types.js';

/** A quote that came back with a usable price. */
export type PricedQuote = Quote & { best: Offer };

/** Quotes that actually produced a price, cheapest first. */
export function pricedQuotes(quotes: Quote[]): PricedQuote[] {
  return quotes
    .filter((q): q is Quote & { best: Offer } => q.status === 'ok' && q.best !== null)
    .sort((a, b) => a.best.amount - b.best.amount);
}

/**
 * Full ranking for display: priced quotes cheapest-first, then everything that
 * is still working, then the ones that failed.
 */
export function rankQuotes(quotes: Quote[]): Quote[] {
  const rank: Record<Quote['status'], number> = {
    ok: 0,
    loading: 1,
    pending: 2,
    'no-price': 3,
    error: 4,
    cancelled: 5,
  };
  return [...quotes].sort((a, b) => {
    const byStatus = rank[a.status] - rank[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.best && b.best) return a.best.amount - b.best.amount;
    return a.candidate.companyName.localeCompare(b.candidate.companyName);
  });
}

export function cheapest(quotes: Quote[]): Quote | null {
  return pricedQuotes(quotes)[0] ?? null;
}

export interface Savings {
  /** Most expensive priced quote — what you'd have paid picking badly. */
  worst: number;
  best: number;
  absolute: number;
  percent: number;
}

/**
 * What the winning code saved against the worst priced result. Null until at
 * least two codes have come back, because a single price has nothing to beat.
 */
export function savings(quotes: Quote[]): Savings | null {
  const priced = pricedQuotes(quotes);
  if (priced.length < 2) return null;
  const best = priced[0]!.best.amount;
  const worst = priced[priced.length - 1]!.best.amount;
  if (worst <= 0) return null;
  return {
    best,
    worst,
    absolute: worst - best,
    percent: ((worst - best) / worst) * 100,
  };
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
 */
export function classMatrix(quotes: Quote[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();

  for (const quote of quotes) {
    for (const offer of quote.offers) {
      if (!offer.label) continue;
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
