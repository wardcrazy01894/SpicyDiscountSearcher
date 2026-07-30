import { describe, expect, it } from 'vitest';

import { classMatrix, cheapest, normalizeLabel, rankQuotes, savings } from '../src/core/compare.js';
import type { Offer, Quote, QuoteStatus } from '../src/core/types.js';

function quote(
  id: string,
  status: QuoteStatus,
  offers: Array<[label: string | null, amount: number]> = [],
): Quote {
  const built: Offer[] = offers.map(([label, amount]) => ({
    label,
    amount,
    currency: 'USD',
    basis: 'total',
  }));
  const best = built.length ? built.reduce((low, o) => (o.amount < low.amount ? o : low)) : null;
  return {
    id,
    candidate: {
      companySlug: id,
      companyName: id.toUpperCase(),
      vendor: 'hertz',
      code: id,
      note: null,
    },
    url: `https://example.test/${id}`,
    status,
    offers: built,
    best,
  };
}

describe('rankQuotes', () => {
  it('puts priced results first, cheapest to dearest, failures last', () => {
    const ranked = rankQuotes([
      quote('c', 'error'),
      quote('a', 'ok', [['Compact', 240]]),
      quote('d', 'loading'),
      quote('b', 'ok', [['Compact', 184]]),
    ]);
    expect(ranked.map((q) => q.id)).toEqual(['b', 'a', 'd', 'c']);
  });
});

describe('cheapest', () => {
  it('ignores quotes that never produced a price', () => {
    const winner = cheapest([quote('a', 'no-price'), quote('b', 'ok', [['Compact', 199]])]);
    expect(winner?.id).toBe('b');
  });
});

describe('savings', () => {
  it('measures the spread between best and worst answered code', () => {
    const spread = savings([
      quote('a', 'ok', [['Compact', 200]]),
      quote('b', 'ok', [['Compact', 250]]),
    ]);
    expect(spread).toEqual({ best: 200, worst: 250, absolute: 50, percent: 20 });
  });

  it('stays null with only one price, which has nothing to beat', () => {
    expect(savings([quote('a', 'ok', [['Compact', 200]]), quote('b', 'error')])).toBeNull();
  });
});

describe('normalizeLabel', () => {
  it('collapses vendor phrasing to a comparable key', () => {
    expect(normalizeLabel('Compact SUV or similar (Ford Escape)')).toBe('compact suv');
    expect(normalizeLabel('  MIDSIZE   ')).toBe('midsize');
  });
});

describe('classMatrix', () => {
  it('lines codes up per class and names the winner of each', () => {
    const rows = classMatrix([
      quote('a', 'ok', [
        ['Compact', 200],
        ['Full Size', 300],
      ]),
      quote('b', 'ok', [
        ['compact or similar', 190],
        ['Minivan', 400],
      ]),
    ]);

    const compact = rows.find((row) => row.label === 'compact');
    expect(compact?.amounts.size).toBe(2);
    expect(compact?.bestQuoteId).toBe('b');
    expect(compact?.bestAmount).toBe(190);
    // Shared classes sort ahead of ones only a single code offered.
    expect(rows[0]?.label).toBe('compact');
  });
});
