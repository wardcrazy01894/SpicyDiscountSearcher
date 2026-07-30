/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import {
  bestOffer,
  classifyBasis,
  extractOffers,
  findPrices,
  parseAmount,
} from '../src/core/extract.js';
import type { Offer } from '../src/core/types.js';

describe('parseAmount', () => {
  it('reads US grouping', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it('reads European grouping', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
  });

  it('reads a bare integer', () => {
    expect(parseAmount('289')).toBe(289);
  });

  it('rejects non-numeric text', () => {
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('findPrices', () => {
  it('finds symbol-prefixed and suffixed amounts', () => {
    expect(findPrices('Total $284.19')).toEqual([{ amount: 284.19, currency: 'USD' }]);
    expect(findPrices('99,50 €')).toEqual([{ amount: 99.5, currency: 'EUR' }]);
  });

  it('ignores amounts too small to be a rate', () => {
    // "$0 due today" and "$3.50 fee" are noise, not the price we are comparing.
    expect(findPrices('$0 due today, $3.50 concession fee')).toEqual([]);
  });

  it('ignores implausibly large numbers', () => {
    expect(findPrices('$1,200,000 insurance coverage')).toEqual([]);
  });
});

describe('classifyBasis', () => {
  it('spots per-day pricing', () => {
    expect(classifyBasis('$41.99 per day')).toBe('per-day');
    expect(classifyBasis('$41.99/night')).toBe('per-day');
  });

  it('spots totals', () => {
    expect(classifyBasis('Estimated total $284.19')).toBe('total');
    expect(classifyBasis('$284.19 for 4 nights')).toBe('total');
  });

  it('admits when it cannot tell', () => {
    expect(classifyBasis('$284.19')).toBe('unknown');
  });
});

describe('extractOffers', () => {
  it('pulls a label and price out of a results page', () => {
    document.body.innerHTML = `
      <main>
        <ul>
          <li><h3>Compact</h3><span>Estimated total</span><span>$184.22</span></li>
          <li><h3>Midsize SUV</h3><span>Estimated total</span><span>$241.08</span></li>
        </ul>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    const amounts = [...new Set(offers.map((o) => o.amount))].sort((a, b) => a - b);
    expect(amounts).toEqual([184.22, 241.08]);
    expect(offers.every((o) => o.basis === 'total')).toBe(true);
    expect(offers.map((o) => o.label)).toContain('Compact');
  });

  it('returns nothing for a page with no prices', () => {
    document.body.innerHTML = '<main><p>No vehicles available for these dates.</p></main>';
    expect(extractOffers(document, 'avis')).toEqual([]);
  });

  it('does not mistake a phone number for a rate', () => {
    document.body.innerHTML = '<main><p>Questions? $1 800 654 3131</p></main>';
    expect(extractOffers(document, 'avis')).toEqual([]);
  });
});

describe('bestOffer', () => {
  const offer = (amount: number, basis: Offer['basis']): Offer => ({
    label: null,
    amount,
    currency: 'USD',
    basis,
  });

  it('prefers a total over a cheaper-looking daily rate', () => {
    // A "$29/day" badge must never beat a real $210 trip total.
    const best = bestOffer([offer(29, 'per-day'), offer(210, 'total'), offer(240, 'total')]);
    expect(best).toEqual(offer(210, 'total'));
  });

  it('falls back to unlabelled prices when no total is shown', () => {
    expect(bestOffer([offer(310, 'unknown'), offer(250, 'unknown')])).toEqual(
      offer(250, 'unknown'),
    );
  });

  it('returns null when there is nothing to rank', () => {
    expect(bestOffer([])).toBeNull();
  });
});
