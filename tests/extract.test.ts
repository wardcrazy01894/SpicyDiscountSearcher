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

  it('reads a lone separator as grouping only when three digits follow', () => {
    // "$1,234" used to come back as 1.234, fall under the plausible-price
    // floor, and vanish — reporting "no usable price" for a page that had one.
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('1.234')).toBe(1234);
    expect(parseAmount('1,234,567')).toBe(1234567);
    // Two digits after the separator is a decimal, in either convention.
    expect(parseAmount('99,50')).toBe(99.5);
    expect(parseAmount('284.19')).toBe(284.19);
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

  it('does not swallow the next number on the line', () => {
    // The digit class used to span whitespace, so "$59 2 seats" read as 592 —
    // a price the page never showed, which then skewed the advertised spread.
    expect(findPrices('From $59 2 seats')).toEqual([{ amount: 59, currency: 'USD' }]);
    // Three following digits is not enough of a guard on its own.
    expect(findPrices('From $59 250 vehicles')).toEqual([{ amount: 59, currency: 'USD' }]);
    expect(findPrices('$49 300+ locations')).toEqual([{ amount: 49, currency: 'USD' }]);
  });

  it('still reads space-grouped thousands', () => {
    expect(findPrices('1 234,56 €')).toEqual([{ amount: 1234.56, currency: 'EUR' }]);
    // Narrow no-break space is what Intl.NumberFormat('fr-FR') emits. Missing
    // it read €1 234,56 as €234.56 — a thousand euros cheaper than the page
    // said, which wins every race it enters.
    expect(findPrices('1\u202f234,56 EUR')).toEqual([{ amount: 1234.56, currency: 'EUR' }]);
    expect(findPrices('1\u2009234,56 €')).toEqual([{ amount: 1234.56, currency: 'EUR' }]);
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

  it('admits when the text describes both kinds at once', () => {
    // A card showing a daily rate *and* a total describes two numbers, so it
    // classifies neither. Answering "per-day" here (because that pattern was
    // tested first) is what tagged real totals as daily rates.
    expect(classifyBasis('$29/day Estimated total $210.00')).toBe('unknown');
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

  it('reads the total and the daily rate on one card as different things', () => {
    // The card carries both numbers. Classifying from the whole card tagged the
    // $210 total as per-day too, emptying the totals bucket so bestOffer had no
    // choice but to hand back $29 as the headline price.
    document.body.innerHTML = `
      <main>
        <ul>
          <li>
            <h3>Compact</h3>
            <span>$29/day</span>
            <span>Estimated total</span>
            <span>$210.00</span>
          </li>
        </ul>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    expect(offers).toContainEqual({
      label: 'Compact',
      amount: 210,
      currency: 'USD',
      basis: 'total',
    });
    expect(offers).toContainEqual({
      label: 'Compact',
      amount: 29,
      currency: 'USD',
      basis: 'per-day',
    });
    expect(bestOffer(offers)?.amount).toBe(210);
  });

  it('keeps a price that sits beside a nested one', () => {
    // The container's own text holds the total; the nested span holds the fee.
    // Dropping containers wholesale deleted the $210 and left the ranker with
    // an $18 "total" — cheaper than anything real, so it won every race.
    document.body.innerHTML = `
      <main>
        <li><h3>Compact</h3><div>Est. total $210.00 <span>+$18.00 fees</span></div></li>
      </main>`;

    const amounts = extractOffers(document, 'hertz').map((o) => o.amount);
    expect(amounts).toContain(210);
    expect(amounts).toContain(18);
  });

  it('reads a heading out of a wrapper div', () => {
    // Heading-in-a-wrapper is the commonest card markup there is. Requiring
    // the heading's own card to contain the price rejected it, stripping the
    // labels that classMatrix exists to compare.
    document.body.innerHTML = `
      <main>
        <li class="card">
          <div class="hdr"><h3>Compact</h3></div>
          <div class="pricing"><span>Estimated total</span><span>$210.00</span></div>
        </li>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    expect(offers.find((o) => o.amount === 210)?.label).toBe('Compact');
  });

  it('does not take its basis from the card next door', () => {
    // previousElementSibling of a card is the *previous card*. Reading its
    // "$29/day" tagged this card's trip total as a daily rate, which the popup
    // then multiplied into a fabricated week-long estimate.
    document.body.innerHTML = `
      <main>
        <ul>
          <li>Economy $29/day</li>
          <li>Compact $210.00</li>
          <li>Midsize $240.00</li>
        </ul>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    expect(offers.find((o) => o.amount === 210)?.basis).not.toBe('per-day');
    expect(offers.find((o) => o.amount === 29)?.basis).toBe('per-day');
  });

  it('gives each card its own heading, not the first one on the page', () => {
    // querySelector on an ancestor returns the first heading in the subtree, so
    // every card's price used to come back labelled "Economy" — classes the
    // page never attached to those numbers, which then poison the class matrix.
    document.body.innerHTML = `
      <main>
        <div><h3>Economy</h3><span>Estimated total</span><span>$180.00</span></div>
        <div><h3>Compact</h3><span>Estimated total</span><span>$150.00</span></div>
        <div><h3>Full Size</h3><span>Estimated total</span><span>$220.00</span></div>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    expect(offers.find((o) => o.amount === 180)?.label).toBe('Economy');
    expect(offers.find((o) => o.amount === 150)?.label).toBe('Compact');
    expect(offers.find((o) => o.amount === 220)?.label).toBe('Full Size');
  });

  it('keeps the label when the heading sits beside a from-price badge', () => {
    // Standard card markup: a "from $29/day" teaser in the header wrapper and
    // the real total below. Requiring the heading's wrapper to be price-free
    // stripped the label here, and with it every shared row classMatrix
    // compares — so the "no vehicle in common" warning fired on normal pages.
    document.body.innerHTML = `
      <main>
        <li class="card">
          <div class="hdr"><h3>Economy</h3><span class="badge">from $29/day</span></div>
          <div class="p"><span>Estimated total</span><span>$189.00</span></div>
        </li>
      </main>`;

    const offers = extractOffers(document, 'hertz');
    expect(offers.find((o) => o.amount === 189)?.label).toBe('Economy');
    expect(offers.find((o) => o.amount === 189)?.basis).toBe('total');
  });

  it('reads a total whose label sits a level further out', () => {
    // The label and the amount are in separate wrapper divs, so neither is the
    // other's sibling and closest(CARD_SELECTOR) stops at the amount's own div.
    // Calling this `unknown` split a real total out of the race it belonged in.
    document.body.innerHTML = `
      <main>
        <li class="card">
          <h3>Room 19</h3>
          <div class="pr">
            <div class="l"><span>Estimated total</span></div>
            <div class="a"><span>$367.00</span></div>
          </div>
        </li>
      </main>`;

    expect(extractOffers(document, 'hilton').find((o) => o.amount === 367)?.basis).toBe('total');
  });

  it('does not let a struck-through was-price become the headline', () => {
    // Was/now pricing is standard on these sites. If the real price loses its
    // basis and the old one keeps it, bestOffer picks the number the customer
    // is no longer being charged.
    document.body.innerHTML = `
      <main>
        <li class="card">
          <h3>Compact</h3>
          <div class="pr">
            <div class="old">Estimated total was <s>$250.00</s></div>
            <div class="new"><span>$210.00</span></div>
          </div>
        </li>
      </main>`;

    expect(bestOffer(extractOffers(document, 'hertz'))?.amount).toBe(210);
  });

  it('does not let page furniture outside the results decide a basis', () => {
    // The search for a labelling ancestor knows only about prices inside the
    // results container, so beyond that edge nothing can stop it — and a nav
    // link saying "Total price guarantee" would tag a nightly rate as a trip
    // total, which is precisely the mixed-basis ranking the guards exist for.
    document.body.innerHTML = `
      <header class="nav"><a href="#">Total price guarantee</a></header>
      <main>
        <div data-testid="hotel-card-list">
          <div class="card"><h3>Standard King</h3><div class="pr"><div class="a">Sold out</div></div></div>
          <div class="card"><h3>Deluxe King</h3><div class="pr"><div class="a"><span>$132.00</span></div></div></div>
        </div>
      </main>`;

    expect(extractOffers(document, 'hilton').find((o) => o.amount === 132)?.basis).toBe('unknown');
  });

  it('does not split a price across element boundaries', () => {
    // Sites break prices up for styling. Separating element boundaries with a
    // space made "$<span>12</span>,<span>500</span>.00" read as $12 — a price
    // that wins every race it enters — and made several other shapes vanish.
    const shapes = [
      '$<span>12</span>,<span>500</span>.00',
      '$1,<span>250</span>.00',
      '$1<span>,250.00</span>',
      '$1,2<span>50</span>.00',
    ];
    const expected = [12500, 1250, 1250, 1250];

    shapes.forEach((shape, index) => {
      document.body.innerHTML = `<main><div class="card"><h3>Suite</h3><div>${shape}<s>$99.00</s></div></div></main>`;
      expect(extractOffers(document, 'hertz').map((o) => o.amount)).toEqual([expected[index]]);
    });
  });

  it('stops at the document body when no vendor container matches', () => {
    // Sixt's selectors miss this page, so the sweep root is <body> — and
    // body.contains(body) is true, so bounding at the root alone still let a
    // nav link classify the rate. Distinct from the test above, which uses a
    // container that does match.
    document.body.innerHTML = `
      <nav><a href="#">Total price guarantee</a></nav>
      <section><div class="card"><h3>King Room</h3><span>$132.00</span></div></section>`;

    expect(extractOffers(document, 'sixt').find((o) => o.amount === 132)?.basis).toBe('unknown');
  });

  it('still reads a label from a header inside the card', () => {
    // nav/header/footer/aside inside a results container are card furniture,
    // not site furniture. Breaking on the tag left this rate `unknown`, which
    // outranks per-day and so mixed it in with real trip totals.
    document.body.innerHTML = `
      <main>
        <div class="offer-list">
          <div class="card"><header>Nightly rate <span>$132.00</span></header></div>
        </div>
      </main>`;

    expect(extractOffers(document, 'sixt').find((o) => o.amount === 132)?.basis).toBe('per-day');
  });

  it('drops the struck price without corrupting the live one', () => {
    // Subtracting the struck string from the full text removed its *first*
    // occurrence, which here is inside the real price — leaving "$1, was" and
    // dropping the vendor out of the race entirely.
    document.body.innerHTML = '<main><div class="p">$1,250.00 was <s>250.00</s></div></main>';
    expect(extractOffers(document, 'hertz').map((o) => o.amount)).toEqual([1250]);

    // Currency symbol outside the strike, which real sites do.
    document.body.innerHTML = '<main><div class="p">$1,250.00 was $<s>250.00</s></div></main>';
    expect(extractOffers(document, 'hertz').map((o) => o.amount)).toEqual([1250]);
  });

  it('keeps a rate per-day when its own wrapper says so', () => {
    // The wrapper is a price site holding the *same* number, so counting sites
    // made it look like a foreign price and discarded the one element that
    // labelled the rate — after which a distant "Estimated total" claimed it.
    document.body.innerHTML = `
      <main>
        <li class="card">
          <h3>Deluxe King</h3>
          <div class="rate"><span>$132.00</span>/night</div>
          <div class="sum">Estimated total $396.00</div>
        </li>
      </main>`;

    const offers = extractOffers(document, 'hilton');
    expect(offers.find((o) => o.amount === 132)?.basis).toBe('per-day');
    expect(offers.find((o) => o.amount === 396)?.basis).toBe('total');
  });

  it('does not let a neighbour total adopt a fee or a nightly rate', () => {
    // Climbing far enough to find "total" also reaches other cards' numbers.
    // A $25 resort fee ranked as a trip total wins every race it enters.
    document.body.innerHTML = `
      <main>
        <ul>
          <li class="card">
            <h3>Junior Suite</h3>
            <div class="pr">Trip total <span>$520.00</span></div>
            <div class="fee"><span>$25.00</span> resort fee</div>
          </li>
          <li class="card"><h3>Executive</h3><div class="amt"><span>$210.00</span> per night</div></li>
        </ul>
      </main>`;

    const offers = extractOffers(document, 'hilton');
    expect(offers.find((o) => o.amount === 25)?.basis).toBe('unknown');
    expect(offers.find((o) => o.amount === 210)?.basis).toBe('per-day');
    expect(bestOffer(offers)?.amount).toBe(520);
  });

  it('reads a total buried several wrappers below its label', () => {
    document.body.innerHTML = `
      <main>
        <li class="card">
          <h3>Compact</h3>
          <div class="pr">
            <div class="l">Estimated total</div>
            <div class="a"><div class="b"><div class="c"><div class="d">
              <span>$355.00</span>
            </div></div></div></div>
          </div>
        </li>
      </main>`;

    expect(extractOffers(document, 'hertz').find((o) => o.amount === 355)?.basis).toBe('total');
  });

  it('reads a total labelled by a sibling div, not just a sibling span', () => {
    // Rejecting siblings by card identity treated the label div as a separate
    // card — a div is its own closest card — so real totals came back
    // `unknown` and were split out of the race they belonged in.
    document.body.innerHTML = `
      <main>
        <div class="card">
          <h3>Compact</h3>
          <div class="p"><div>Estimated total</div><div>$210.00</div></div>
        </div>
      </main>`;

    expect(extractOffers(document, 'hertz').find((o) => o.amount === 210)?.basis).toBe('total');
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

  it('does not treat a converted price as the cheaper one', () => {
    // European pages often show a converted price beside the real one. Picking
    // the smaller numeral across currencies compares nothing.
    const euro: Offer = { label: null, amount: 150, currency: 'EUR', basis: 'total' };
    const best = bestOffer([offer(210, 'total'), offer(240, 'total'), euro]);
    expect(best?.currency).toBe('USD');
    expect(best?.amount).toBe(210);
  });
});
