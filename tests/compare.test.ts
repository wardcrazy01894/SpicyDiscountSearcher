import { describe, expect, it } from 'vitest';

import {
  cheapestComparable,
  classMatrix,
  comparisonGroups,
  estimatedTotal,
  normalizeLabel,
  orderForDisplay,
  savings,
  tripUnits,
  unrankedQuotes,
} from '../src/core/compare.js';
import { bestOffer } from '../src/core/extract.js';
import type {
  CarTrip,
  HotelTrip,
  Offer,
  PriceBasis,
  Quote,
  QuoteStatus,
} from '../src/core/types.js';

type OfferSpec = [label: string | null, amount: number, basis?: PriceBasis, currency?: string];

function quote(id: string, status: QuoteStatus, offers: OfferSpec[] = []): Quote {
  const built: Offer[] = offers.map(([label, amount, basis = 'total', currency = 'USD']) => ({
    label,
    amount,
    currency,
    basis,
  }));
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
    confidence: 'best-effort',
    status,
    offers: built,
    // Same path the service worker uses, so the fixtures can't drift from it.
    best: bestOffer(built),
  };
}

const CAR_TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '10:00',
  dropoffDate: '2026-09-11',
  dropoffTime: '10:00',
};

const HOTEL_TRIP: HotelTrip = {
  category: 'hotel',
  destination: 'Chicago',
  checkIn: '2026-09-04',
  checkOut: '2026-09-07',
  adults: 2,
  rooms: 1,
};

describe('comparisonGroups', () => {
  it('never lets a daily rate undercut a rival trip total', () => {
    // The whole point of the tool: $29/day for a week is ~$203, not $29, so it
    // must not be crowned over a real $219 total just by being a smaller number.
    const quotes = [
      quote('daily', 'ok', [['Compact', 29, 'per-day']]),
      quote('total-a', 'ok', [['Compact', 219]]),
      quote('total-b', 'ok', [['Compact', 240]]),
    ];

    expect(cheapestComparable(quotes)?.id).toBe('total-a');
    expect(unrankedQuotes(quotes).map((q) => q.id)).toEqual(['daily']);
  });

  it('keeps currencies apart rather than comparing the numerals', () => {
    const quotes = [
      quote('eur', 'ok', [['Compact', 99, 'total', 'EUR']]),
      quote('usd-a', 'ok', [['Compact', 120]]),
      quote('usd-b', 'ok', [['Compact', 150]]),
    ];

    expect(cheapestComparable(quotes)?.id).toBe('usd-a');
    expect(unrankedQuotes(quotes).map((q) => q.id)).toEqual(['eur']);
  });

  it('prefers a bucket with a rival in it over a lone quote', () => {
    // One trip total has nothing to beat; two daily rates are a real race.
    const groups = comparisonGroups([
      quote('a', 'ok', [['Compact', 29, 'per-day']]),
      quote('b', 'ok', [['Compact', 31, 'per-day']]),
      quote('c', 'ok', [['Compact', 219]]),
    ]);

    expect(groups.map((g) => g.basis)).toEqual(['per-day', 'total']);
    expect(groups[0]?.quotes.map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('does not let a bigger daily-rate race demote a real total race', () => {
    // Both are races, so trustworthiness decides — otherwise three codes
    // quoting a daily rate would bury two codes quoting the actual trip cost,
    // contradicting the basis preference bestOffer already applies per page.
    const groups = comparisonGroups([
      quote('d1', 'ok', [['Compact', 29, 'per-day']]),
      quote('d2', 'ok', [['Compact', 31, 'per-day']]),
      quote('d3', 'ok', [['Compact', 33, 'per-day']]),
      quote('t1', 'ok', [['Compact', 219]]),
      quote('t2', 'ok', [['Compact', 240]]),
    ]);

    expect(groups[0]?.basis).toBe('total');
    expect(cheapestComparable([...groups.flatMap((g) => g.quotes)])?.id).toBe('t1');
  });

  it('ignores quotes that never produced a price', () => {
    const winner = cheapestComparable([
      quote('a', 'no-price'),
      quote('b', 'ok', [['Compact', 199]]),
    ]);
    expect(winner?.id).toBe('b');
  });
});

describe('orderForDisplay', () => {
  it('puts priced results first, cheapest to dearest, failures last', () => {
    const ranked = orderForDisplay([
      quote('c', 'error'),
      quote('a', 'ok', [['Compact', 240]]),
      quote('d', 'loading'),
      quote('b', 'ok', [['Compact', 184]]),
    ]);
    expect(ranked.map((q) => q.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('orders every status, not just the three the happy path produces', () => {
    const ranked = orderForDisplay([
      quote('cancelled', 'cancelled'),
      quote('error', 'error'),
      quote('noprice', 'no-price'),
      quote('pending', 'pending'),
      quote('loading', 'loading'),
      quote('ok', 'ok', [['Compact', 100]]),
    ]);
    expect(ranked.map((q) => q.status)).toEqual([
      'ok',
      'loading',
      'pending',
      'no-price',
      'error',
      'cancelled',
    ]);
  });

  it('breaks ties between unpriced quotes on company name', () => {
    const ranked = orderForDisplay([quote('zeta', 'error'), quote('alpha', 'error')]);
    expect(ranked.map((q) => q.id)).toEqual(['alpha', 'zeta']);
  });

  it('lists the comparable race before the codes that quoted something else', () => {
    // A cheaper-looking daily rate sorts below the totals it cannot beat,
    // rather than jumping to the top of the list.
    const ranked = orderForDisplay([
      quote('daily', 'ok', [['Compact', 29, 'per-day']]),
      quote('total-b', 'ok', [['Compact', 240]]),
      quote('total-a', 'ok', [['Compact', 219]]),
    ]);
    expect(ranked.map((q) => q.id)).toEqual(['total-a', 'total-b', 'daily']);
  });
});

describe('a quote that landed somewhere other than the search', () => {
  // The failure this closes, measured rather than imagined: sixt's builder
  // targets /php/reservation, which 302s to https://www.sixt.com/ with the
  // location field empty and "$35" on the page. The probe reads that, the quote
  // comes back `ok` with a real number, and because a marketing rate is cheaper
  // than any genuine one it took the primary bucket and won outright. The popup
  // put a flag on the row and still ranked it first, which reads as an answer
  // with a caveat rather than as no answer at all.

  const landed = (): Quote => {
    const q = quote('sixt', 'ok', [['Economy', 35, 'per-day']]);
    q.suspect = 'landed-elsewhere';
    return q;
  };
  const real = (): Quote => quote('hertz', 'ok', [['Economy', 60, 'per-day']]);

  it('cannot win the race by being cheaper than anything real', () => {
    expect(cheapestComparable([landed(), real()])?.id).toBe('hertz');
  });

  it('is listed rather than dropped, so the code does not look untried', () => {
    expect(unrankedQuotes([landed(), real()]).map((q) => q.id)).toContain('sixt');
  });

  it('does not become the saving', () => {
    // Two real quotes plus the suspect one. The spread must be 100 against 60,
    // not against the home page's 35.
    const other = quote('avis', 'ok', [['Economy', 100, 'per-day']]);
    const result = savings([landed(), real(), other]);
    expect(result?.best).toBe(60);
    expect(result?.worst).toBe(100);
  });

  it('sorts below the winner rather than above it', () => {
    // It has no bucket now, and an unbucketed quote used to inherit rank 0 —
    // so the excluded $35 was rendered first, with the real winner highlighted
    // beneath it. Same misreading, quieter.
    const other = quote('avis', 'ok', [['Economy', 100, 'per-day']]);
    const order = orderForDisplay([landed(), real(), other]).map((q) => q.id);
    expect(order.indexOf('sixt')).toBeGreaterThan(order.indexOf('hertz'));
    expect(order[0]).toBe('hertz');
  });

  it('is listed exactly once, never twice', () => {
    // `unrankedQuotes` concatenates the out-of-bucket quotes with the suspect
    // ones, and only `pricedOnly`'s filter — in a different function — keeps a
    // quote out of both halves. Re-including suspect there would list the same
    // code twice and inflate the popup's count.
    //
    // The suspect quote has to sit *outside* the primary bucket for this to mean
    // anything. An earlier version used a suspect quote in the same basis and
    // currency as the winner, so `comparisonGroups(...).slice(1)` was empty
    // whatever `pricedOnly` did and the test passed under the very mutation its
    // comment named.
    const outsider = quote('sixt', 'ok', [['Economy', 35, 'total', 'EUR']]);
    outsider.suspect = 'landed-elsewhere';
    const ids = unrankedQuotes([
      outsider,
      real(),
      quote('avis', 'ok', [['Economy', 100, 'per-day']]),
    ]).map((q) => q.id);
    expect(ids.filter((id) => id === 'sixt')).toHaveLength(1);
  });

  it('does not make a lone real quote look like a race', () => {
    // One genuine price and one home-page price is not two rivals, and
    // announcing a 42% saving off a number nobody can book is the worst
    // possible reading of it.
    expect(savings([landed(), real()])).toBeNull();
  });
});

describe('savings', () => {
  it('measures the spread between best and worst answered code', () => {
    const spread = savings([
      quote('a', 'ok', [['Compact', 200]]),
      quote('b', 'ok', [['Compact', 250]]),
    ]);
    expect(spread).toEqual({
      best: 200,
      worst: 250,
      absolute: 50,
      percent: 20,
      currency: 'USD',
      basis: 'total',
    });
  });

  it('stays null with only one price, which has nothing to beat', () => {
    expect(savings([quote('a', 'ok', [['Compact', 200]]), quote('b', 'error')])).toBeNull();
  });

  it('does not count a differently-based quote as a rival', () => {
    // One total and one daily rate is not a race, so there is no spread to
    // advertise — reporting "87% saved" here would be inventing a comparison.
    expect(
      savings([
        quote('a', 'ok', [['Compact', 219]]),
        quote('b', 'ok', [['Compact', 29, 'per-day']]),
      ]),
    ).toBeNull();
  });
});

describe('tripUnits', () => {
  it('counts rental days and hotel nights', () => {
    expect(tripUnits(CAR_TRIP)).toBe(7);
    expect(tripUnits(HOTEL_TRIP)).toBe(3);
  });

  it('bills a same-day car rental as one day but rejects a zero-night stay', () => {
    expect(tripUnits({ ...CAR_TRIP, dropoffDate: CAR_TRIP.pickupDate })).toBe(1);
    expect(tripUnits({ ...HOTEL_TRIP, checkOut: HOTEL_TRIP.checkIn })).toBeNull();
  });

  it('returns null for dates it cannot read', () => {
    expect(tripUnits({ ...CAR_TRIP, dropoffDate: '' })).toBeNull();
  });

  it('refuses a date that only looks valid', () => {
    // Date.UTC rolls "2026-02-30" over into March 2 without complaint, which
    // would yield a plausible but wrong trip length.
    expect(tripUnits({ ...CAR_TRIP, dropoffDate: '2026-02-30' })).toBeNull();
    expect(tripUnits({ ...CAR_TRIP, dropoffDate: '2026-13-05' })).toBeNull();
  });
});

describe('estimatedTotal', () => {
  const offer = (amount: number, basis: PriceBasis): Offer => ({
    label: null,
    amount,
    currency: 'USD',
    basis,
  });

  it('projects a daily rate across the trip', () => {
    expect(estimatedTotal(offer(29, 'per-day'), CAR_TRIP)).toBe(203);
  });

  it('refuses to project anything that is already a total', () => {
    expect(estimatedTotal(offer(219, 'total'), CAR_TRIP)).toBeNull();
    expect(estimatedTotal(offer(219, 'unknown'), CAR_TRIP)).toBeNull();
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
    const rows = classMatrix(
      [
        quote('a', 'ok', [
          ['Compact', 200],
          ['Full Size', 300],
        ]),
        quote('b', 'ok', [
          ['compact or similar', 190],
          ['Minivan', 400],
        ]),
      ],
      { basis: 'total', currency: 'USD' },
    );

    const compact = rows.find((row) => row.label === 'compact');
    expect(compact?.amounts.size).toBe(2);
    expect(compact?.bestQuoteId).toBe('b');
    expect(compact?.bestAmount).toBe(190);
    // Shared classes sort ahead of ones only a single code offered.
    expect(rows[0]?.label).toBe('compact');
  });

  it('only compares offers inside one basis and currency', () => {
    // Without the filter the $35/day "Compact" would beat the $200 total
    // "Compact" and the fairness check would report the wrong winner.
    const rows = classMatrix(
      [
        quote('total', 'ok', [['Compact', 200]]),
        quote('daily', 'ok', [['Compact', 35, 'per-day']]),
      ],
      { basis: 'total', currency: 'USD' },
    );

    const compact = rows.find((row) => row.label === 'compact');
    expect(compact?.amounts.size).toBe(1);
    expect(compact?.bestQuoteId).toBe('total');
  });
});

describe('the class matrix and the quotes it is given', () => {
  // bestOffer picks a quote's headline basis and currency by majority, so a
  // quote quoting mostly euros sits outside a USD reported bucket and the
  // popup lists it as "not ranked". Its stray dollar offers, though, are still
  // offers — and feeding the matrix every quote let one of them hold the
  // cheapest row. The popup then warned that "another code is cheaper on the
  // classes these results have in common", naming a code it had just told the
  // user was not comparable at all.
  const usdWinner = quote('A', 'ok', [['Economy', 100, 'total', 'USD']]);
  const euroMajority = quote('B', 'ok', [
    ['Economy', 90, 'total', 'EUR'],
    ['Economy', 95, 'total', 'EUR'],
    ['Economy', 50, 'total', 'USD'],
  ]);
  const usdRival = quote('C', 'ok', [['Economy', 110, 'total', 'USD']]);
  const all = [usdWinner, euroMajority, usdRival];

  it('leaves the euro-majority quote out of the reported bucket', () => {
    const ranked = comparisonGroups(all)[0]?.quotes.map((q) => q.id) ?? [];
    expect(ranked).toContain('A');
    expect(ranked).not.toContain('B');
  });

  it('lets a stray offer from an unranked quote win a row when given every quote', () => {
    // Not the desired behaviour — this is the bug, pinned so the fix below has
    // something to be a fix of.
    const rows = classMatrix(all, { basis: 'total', currency: 'USD' });
    expect(rows.find((r) => r.label === 'economy')?.bestQuoteId).toBe('B');
  });

  it('does not, when given only the quotes that were actually ranked', () => {
    const ranked = comparisonGroups(all)[0]?.quotes ?? [];
    const rows = classMatrix(ranked, { basis: 'total', currency: 'USD' });
    expect(rows.find((r) => r.label === 'economy')?.bestQuoteId).toBe('A');
  });
});
