/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  VENDOR_SELECTORS,
  bestOffer,
  classifyBasis,
  extract,
  extractOffers,
  findPrices,
  parseAmount,
} from '../src/core/extract.js';
import type { Offer } from '../src/core/types.js';
import { searchableVendors } from '../src/core/vendors.js';

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

  it('ignores a running cart total of zero', () => {
    // Observed on Enterprise's live "Select Vehicle Class" page: a header
    // widget reading `TOTAL $ 0 .00` before anything is selected, with the
    // amount split across elements so offerText joins it with spaces. It says
    // "total", which is the most-trusted basis there is, and zero undercuts
    // every genuine rate in the race.
    //
    // What this actually pins, stated honestly: that the *spaced* form parses
    // to 0 and is then rejected, rather than parsing to something else. It is
    // not a guard on the value of MIN_PLAUSIBLE — relaxing 5 to 1 leaves it
    // green, and the `$0 due today` case above already covers amount-zero
    // rejection. It earns its place because the split-across-elements shape is
    // the one real pages produce and the one a change to PRICE_RE could break.
    // `Estimated Total0` carries no currency at all, so it never matches;
    // pinned alongside because only the first is a near miss.
    expect(findPrices('TOTAL $ 0 .00')).toEqual([]);
    expect(findPrices('Estimated Total0')).toEqual([]);
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
    // other's sibling, so the ancestor climb has to keep going past div.a.
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

describe("National's results container", () => {
  // Built from the live results page, where the fix is narrower than it first
  // looked. The old entry — `.car-class-list, [data-testid="vehicle-list"]` —
  // was copied from Enterprise when National could not be searched, and matches
  // **nothing** on National, so every scope fell through to `main`: 78.6k of the
  // page's 79.4k characters, rental terms included.
  //
  // That is less alarming than it sounds, and the honest version is worth
  // recording: the terms quote "$7.00 per day" and "$1 million per accident",
  // and neither survives extraction anyway — `isFeeLine` strips the first as a
  // charge and MIN_PLAUSIBLE rejects the second. The sweep does not scoop prose.
  // What scoping buys is that a *price-shaped* element outside the car list —
  // a promo tile, an upsell — cannot enter the race.
  const PAGE = `
    <main>
      <div class="vehicle-list">
        <div class="vehicle">
          <span>Compact SUV</span>
          <div class="vehicle__price">$ 70.30 / day $ 185.05 Est. Total</div>
        </div>
        <div class="vehicle">
          <span>Full Size SUV</span>
          <div class="vehicle__price">$ 133.00 / day $ 320.10 Est. Total</div>
        </div>
      </div>
      <section class="promo">
        <h3>Weekend deal</h3>
        <span>From</span><span>$9.99</span><span>per day</span>
      </section>
    </main>`;

  it('prices the cars and not the promo beside them', () => {
    document.body.innerHTML = PAGE;
    const amounts = extract(document, 'national').offers.map((o) => o.amount);
    expect(amounts).toContain(70.3);
    expect(amounts).toContain(185.05);
    expect(amounts).not.toContain(9.99);
  });

  it('shows what the scope is worth, using a vendor whose selectors miss', () => {
    // sixt's list matches nothing here and falls through to `main`, which is the
    // state National shipped in. Hertz would *not* show it — its list happens to
    // contain `.vehicle-list` too, so it scopes correctly by luck, which is why
    // this control names a vendor deliberately.
    document.body.innerHTML = PAGE;
    expect(extract(document, 'sixt').offers.map((o) => o.amount)).toContain(9.99);
  });
});

describe('the per-vendor selector path', () => {
  // No entry in VENDOR_SELECTORS defines `offer`, so this branch never runs
  // against real vendors and every ProbeReport says "generic-sweep". That
  // makes it unreachable, not optional: CLAUDE.md promises extraction "tries
  // per-vendor CSS first and falls back to a generic sweep", and the day
  // someone fills in a selector this has to do what the doc says. Pinned with
  // an injected config so the capability is proven rather than assumed.
  const CONFIG = VENDOR_SELECTORS as Record<string, unknown>;
  const original = CONFIG['hertz'];

  afterEach(() => {
    CONFIG['hertz'] = original;
  });

  it('reads one offer per node and reports the branch it used', () => {
    CONFIG['hertz'] = {
      container: 'main',
      offer: '.veh',
      label: '.name',
      price: '.amt',
    };
    document.body.innerHTML = `
      <main>
        <div class="veh"><span class="name">Compact</span><span class="amt">Estimated total $210.00</span></div>
        <div class="veh"><span class="name">Midsize</span><span class="amt">Estimated total $240.00</span></div>
      </main>`;

    const result = extract(document, 'hertz');
    expect(result.path).toBe('vendor-selectors');
    expect(result.offers.map((o) => [o.label, o.amount])).toEqual([
      ['Compact', 210],
      ['Midsize', 240],
    ]);
  });

  // Note this one passes with the branch deleted — the sweep would run anyway.
  // It is here to pin the *reported branch*, which is the part that would go
  // wrong silently if the fallback stopped labelling itself.
  it('reports the sweep when the selectors match nothing', () => {
    CONFIG['hertz'] = { container: 'main', offer: '.gone-in-a-redesign' };
    document.body.innerHTML =
      '<main><li><h3>Compact</h3><span>Estimated total</span><span>$210.00</span></li></main>';

    const result = extract(document, 'hertz');
    expect(result.path).toBe('generic-sweep');
    expect(result.offers.find((o) => o.amount === 210)?.label).toBe('Compact');
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

describe('numbers that are not prices for anything bookable', () => {
  it('does not let a tax line become the page price, however it is wrapped', () => {
    // The whole basis machinery cannot save you from a number that was never a
    // rate. "Total taxes and fees" carries the word `total`, so it was tagged
    // `total`, and being the cheapest number on the most trusted basis it
    // became the headline — a hotel reported at $57.20, "88% under the
    // priciest comparable code", from a page whose real rate was $189/night.
    document.body.innerHTML = `
      <main>
        <div class="hotel">
          <h3>Hilton Chicago</h3>
          <div class="rate"><span>$189</span> <span>/night</span></div>
          <div class="fees">Total taxes and fees: <span>$57.20</span></div>
        </div>
      </main>`;
    const offers = extractOffers(document, 'hilton');
    expect(offers.map((o) => o.amount)).not.toContain(57.2);
    expect(bestOffer(offers)?.amount).toBe(189);
  });

  it('does not let a savings line become the page price', () => {
    document.body.innerHTML = `
      <main>
        <div class="card">
          <h3>Midsize</h3>
          <div class="t">Estimated total $412.00</div>
          <div class="s">Total savings $50.00</div>
        </div>
      </main>`;
    const offers = extractOffers(document, 'hertz');
    expect(offers.map((o) => o.amount)).not.toContain(50);
    expect(bestOffer(offers)?.amount).toBe(412);
  });

  it('keeps a real total that merely mentions its components', () => {
    // The discriminator is which noun leads the line, not whether the words
    // "taxes and fees" appear anywhere in it. Rejecting on the words alone
    // would throw away the most valuable number on the page.
    document.body.innerHTML = `
      <main><div class="card"><h3>Economy</h3>
        <div class="t">Estimated total $412.00 including taxes and fees</div>
      </div></main>`;
    const offers = extractOffers(document, 'hertz');
    expect(offers).toHaveLength(1);
    expect(offers[0]?.amount).toBe(412);
    expect(offers[0]?.basis).toBe('total');
  });

  it('reads a total whose wording runs past the old length cap', () => {
    // 47 characters. At a 40-character cap this element was skipped, the page
    // reported `probe-empty`, and which vendors reached the ranking depended
    // on how verbose their card copy happened to be.
    const line = 'Estimated total $412.00 including taxes and fees';
    expect(line.length).toBeGreaterThan(40);
    document.body.innerHTML = `<main><div class="t">${line}</div></main>`;
    expect(extractOffers(document, 'hertz').map((o) => o.amount)).toEqual([412]);
  });
});

describe('prices split across elements', () => {
  it('reads a rate whose unit sits in a sibling span', () => {
    // The fast path returned textContent whenever nothing struck-through sat
    // below — which is almost every element — so the boundary space this is
    // all for was inserted only by accident. "$132.00per night" classified
    // `unknown`, and a nightly rate landed in the bucket with trip totals.
    document.body.innerHTML = '<main><div class="rate">$132.00<span>per night</span></div></main>';
    const offers = extractOffers(document, 'hilton');
    expect(offers[0]?.basis).toBe('per-day');
  });

  it('reads it the same way when a was-price is present', () => {
    // Same markup, same rate, plus an unrelated struck-through price. The old
    // code gave two different answers for the identical number depending on
    // whether this element existed.
    document.body.innerHTML =
      '<main><div class="rate"><s>$180</s>$132.00<span>per night</span></div></main>';
    const offers = extractOffers(document, 'hilton');
    expect(offers[0]?.basis).toBe('per-day');
    expect(offers.map((o) => o.amount)).not.toContain(180);
  });

  it('still refuses to join two numbers into a bigger one', () => {
    document.body.innerHTML = '<main><div class="p">$<span>12</span>,<span>500</span></div></main>';
    expect(extractOffers(document, 'hertz').map((o) => o.amount)).toEqual([12500]);
  });
});

describe('currencies that are not US dollars', () => {
  it.each([
    ['CA$150.00', 'CAD'],
    ['C$150.00', 'CAD'],
    ['A$150.00', 'AUD'],
    ['NZ$150.00', 'NZD'],
  ])('reads %s as %s rather than USD', (text, currency) => {
    // A Canadian dollar filed as USD buckets with real US prices and wins on
    // face value — a cross-currency comparison arriving inside a single
    // bucket, where the guard against exactly that cannot see it.
    expect(findPrices(text)).toEqual([{ amount: 150, currency }]);
  });

  it('still reads a plain dollar as USD', () => {
    expect(findPrices('$150.00')).toEqual([{ amount: 150, currency: 'USD' }]);
    expect(findPrices('US$150.00')).toEqual([{ amount: 150, currency: 'USD' }]);
  });
});

describe('labels', () => {
  it('does not give a promo banner the first card class', () => {
    // The outward walk ended at the results container, and headingText()
    // querySelectors whatever it is handed — so the banner inherited the first
    // card's <h3>. That price then beat every real rate AND looked comparable
    // to them, so classMatrix saw the winner leading its own class and said
    // nothing. A wrong label defeats the check meant to catch a wrong winner.
    document.body.innerHTML = `
      <main>
        <div class="promo">Weekend deals from $19/day</div>
        <div class="card"><h3>Economy</h3><div>$29.99 per day</div></div>
        <div class="card"><h3>Midsize</h3><div>$34.99 per day</div></div>
      </main>`;
    const offers = extractOffers(document, 'hertz');
    const banner = offers.find((o) => o.amount === 19);
    expect(banner).toBeDefined();
    expect(banner?.label).toBeNull();
    // The real cards keep theirs.
    expect(offers.find((o) => o.amount === 29.99)?.label).toBe('Economy');
    expect(offers.find((o) => o.amount === 34.99)?.label).toBe('Midsize');
  });

  it('still lets a card inherit a heading from its own wrapper', () => {
    // The documented, accepted limit — a heading one level up is still this
    // card's heading. Only the container itself is out of bounds.
    document.body.innerHTML = `
      <main><div class="card">
        <div class="hdr"><h3>Economy</h3></div>
        <div class="p">$29.99 per day</div>
      </div></main>`;
    expect(extractOffers(document, 'hertz')[0]?.label).toBe('Economy');
  });

  it('stops at a container that is not body, html or main', () => {
    // The test above cannot fail for the right reason. Its root is <main>,
    // which CHROME_SELECTOR already matches, so `node === root` in labelNear is
    // doing nothing there and deleting it leaves the suite green.
    //
    // This is the shape where the bound is the only thing standing: a page with
    // no <main> at all, whose container selector matches a plain <div>. Sixt's
    // selector list includes `.offer-list`, so that div becomes the root while
    // matching none of `body, html, main`. Without the bound the walk reaches it
    // and headingText() querySelectors the whole results list, handing the promo
    // banner the first card's class — the exact mislabel the test above is about.
    document.body.innerHTML = `
      <div class="offer-list">
        <div class="promo">Weekend deals from $19/day</div>
        <div class="card"><h3>Economy</h3><div>$29.99 per day</div></div>
        <div class="card"><h3>Midsize</h3><div>$34.99 per day</div></div>
      </div>`;
    const offers = extractOffers(document, 'sixt');
    expect(offers.find((o) => o.amount === 19)?.label).toBeNull();
    expect(offers.find((o) => o.amount === 29.99)?.label).toBe('Economy');
    expect(offers.find((o) => o.amount === 34.99)?.label).toBe('Midsize');
  });
});

describe('fee lines and the prices that live beside them', () => {
  const only = (html: string): string[] => {
    document.body.innerHTML = `<main><div class="t">${html}</div></main>`;
    return extractOffers(document, 'hertz').map((o) => `${o.amount}/${o.basis}`);
  };

  it.each([
    'Total taxes and fees: $57.20',
    'Taxes and fees $57.20',
    'Total savings $50.00',
    'Resort fee $35.00',
  ])('drops %s', (line) => {
    expect(only(line)).toEqual([]);
  });

  it.each([
    // Every one of these leads with a fee noun and quotes a real rate. An
    // earlier version of this fix rejected the lot, which is worse than the bug
    // it was fixing: a lost price drops the vendor out of the race silently.
    ['Fees included — $412 total', '412/total'],
    ['Fees and taxes included: $412.00', '412/unknown'],
    ['Deposit waived · $210 total', '210/total'],
    ['Savings Rate $89/day', '89/per-day'],
    ['Discount rate $89.00/day', '89/per-day'],
    ['Estimated total $412.00 including taxes and fees', '412/total'],
  ])('keeps the real price in %s', (line, expected) => {
    expect(only(line)).toEqual([expected]);
  });

  it('suppresses a savings badge sharing an element with a total', () => {
    // Cannot be split by text alone, and emitting both makes the $50 a `total`
    // that wins outright. Losing the $412 costs a vendor its place in the race;
    // keeping the $50 crowns the wrong one.
    expect(only('Save $50 · $412 total')).toEqual([]);
  });

  it('does not let an ambiguous wrapper emit a daily rate as the headline', () => {
    // Both numbers classify `unknown`, and `unknown` outranks `per-day`, so the
    // $29 became the page price and bucketed with real trip totals.
    document.body.innerHTML = `<main><div class="card">
      <span>Economy</span> $29 per day, estimated total $210 for 3 days
    </div></main>`;
    expect(bestOffer(extractOffers(document, 'hertz'))).toBeNull();
  });

  it('still finds the rate when the fee sits in its own element', () => {
    document.body.innerHTML = `<main><div class="card">
      <h3>Deluxe King</h3>
      <div class="rate">$189<span>/night</span></div>
      <div class="fees">Taxes and fees: <span>$57.20</span></div>
    </div></main>`;
    const offers = extractOffers(document, 'hilton');
    expect(offers.map((o) => o.amount)).toEqual([189]);
    expect(bestOffer(offers)?.amount).toBe(189);
  });
});

describe('an inclusive word after the price is not a licence', () => {
  it.each([
    // Amenity copy mentions "free" and "included" constantly. Tested against
    // the whole string, the inclusive rule was an escape hatch wide enough to
    // undo the fix — and worse than before the cap was raised, because these
    // elements used to be dropped for length instead.
    'Total taxes and fees $57.20 (VAT included)',
    'Taxes and fees $57.20 · Free cancellation',
    'Taxes and fees: $57.20. Free cancellation',
    'Taxes and fees $57.20, breakfast included',
  ])('keeps the rate as the headline beside %s', (fee) => {
    // The stronger property, and the one the code delivers: the fee is absent
    // from the offer list, not merely outranked by a cheaper real rate.
    document.body.innerHTML = `<main><div class="card">
      <h3>Deluxe King</h3>
      <div class="rate">$189.00 per night</div>
      <div class="fees">${fee}</div>
    </div></main>`;
    const offers = extractOffers(document, 'hilton');
    expect(offers.map((o) => o.amount)).toEqual([189]);
    // Same DOM, already extracted — the helper this replaced rebuilt it
    // identically and re-ran extractOffers to answer the second question.
    const best = bestOffer(offers);
    expect(best && `${best.amount}/${best.basis}`).toBe('189/per-day');
  });

  it.each([
    ['Fees included — $412 total', '412/total'],
    ['Fees and taxes included: $412.00', '412/unknown'],
    ['Deposit waived · $210 total', '210/total'],
  ])('still keeps %s, where the inclusive word comes first', (line, expected) => {
    document.body.innerHTML = `<main><div class="t">${line}</div></main>`;
    expect(extractOffers(document, 'hertz').map((o) => `${o.amount}/${o.basis}`)).toEqual([
      expected,
    ]);
  });

  it.each(['Plus taxes and fees $57.20', 'Additional fees $57.20'])(
    'recognises %s as a fee line',
    (line) => {
      document.body.innerHTML = `<main><div class="t">${line}</div></main>`;
      expect(extractOffers(document, 'hertz')).toEqual([]);
    },
  );
});

describe('model names are not money', () => {
  it.each([
    '2024 Cadillac Escalade',
    '2023 Audi Q5 or similar',
    'Seats 5 Audi A3',
    '5 audio inputs',
    '2022 Cadillac CT5',
  ])('finds no price in %s', (text) => {
    // On a car-rental extension `CAD` is the start of Cadillac and `AUD` of
    // Audi, and the suffix branch reads `(number) (currency)`. Unbounded, the
    // model year became a price — and because `unknown` outranks `per-day` in
    // BASIS_PREFERENCE, it became the *headline* price, beating every real
    // rate on the page. Every vendor lists model years, so every quote landed
    // in the same phantom CAD bucket and the race was decided on model years.
    expect(findPrices(text)).toEqual([]);
  });

  it.each([
    ['412 USD', 'USD'],
    ['USD 412', 'USD'],
    ['412 CAD', 'CAD'],
    ['CAD 412', 'CAD'],
    ['412 AUD', 'AUD'],
  ])('still reads %s as a standalone code', (text, currency) => {
    expect(findPrices(text)).toEqual([{ amount: 412, currency }]);
  });

  it('does not let a model year outrank a real rate on the page', () => {
    document.body.innerHTML = `
      <main>
        <div class="card"><h3>2024 Cadillac Escalade</h3><div>$89.00 per day</div></div>
        <div class="card"><h3>2023 Audi Q5 or similar</h3><div>$95.00 per day</div></div>
      </main>`;
    const offers = extractOffers(document, 'hertz');
    expect(offers.map((o) => o.amount).sort((a, b) => a - b)).toEqual([89, 95]);
    expect(bestOffer(offers)?.amount).toBe(89);
    expect(bestOffer(offers)?.currency).toBe('USD');
  });

  it.each([
    ['2023 Audi Q5 $95.00 per day', 95],
    ['Cadillac XT5 $150.00 total', 150],
    ['BMW X3 $110.00 total', 110],
    ['Mazda CX-5 $72.50 per day', 72.5],
    ['Ford F-150 $89.00 per day', 89],
    ['Mercedes E-350 $200.00 total', 200],
  ])('reads the price in %s, not the digit in the model name', (text, amount) => {
    // The model-year phantom came through the currency-*code* branch and was
    // closed by the letter lookaround on CURRENCY_CODE. This is the same defect
    // arriving through the *symbol* branch: `(NUMBER)\s*(CURRENCY)` matched the
    // trailing digit of `Q5` against the `$` after it and ate the dollar sign,
    // leaving the real amount with no currency to pair with. `$5 total` then
    // beat every genuine rate in the race.
    expect(findPrices(text)).toEqual([{ amount, currency: 'USD' }]);
  });

  it('refuses a model-name digit without inventing a number instead', () => {
    // Guarding only the first position of a digit run refuses nothing: with
    // `150` blocked the engine simply started at `50`, which is preceded by a
    // digit rather than a letter. That reported 50 USD — a figure printed
    // nowhere on the page, and cheaper than the 89 it displaced, so it would
    // have won. The lookbehind has to exclude digits for that reason.
    expect(findPrices('Ford F-150 $89.00 per day')).toEqual([{ amount: 89, currency: 'USD' }]);
    expect(findPrices('Ford F-150 $89.00 per day')).not.toContainEqual({
      amount: 50,
      currency: 'USD',
    });
  });

  it.each([
    ['95.00 USD', 95, 'USD'],
    ['1,234.56 USD', 1234.56, 'USD'],
    ['45 $', 45, 'USD'],
    ['1 234,56 €', 1234.56, 'EUR'],
  ])('still reads %s, which the suffix branch is for', (text, amount, currency) => {
    // The guard must not cost the suffix branch its real job. `45 $` in
    // particular is how fr-CA writes money, which is why the branch cannot
    // simply stop accepting a symbol after a number.
    expect(findPrices(text)).toEqual([{ amount, currency }]);
  });

  it('still reads a bare count before a price as the count — a known escape', () => {
    // Not fixed, and pinned so a later change to PRICE_RE is deliberate rather
    // than accidental. Blocking this needs the suffix branch to reject `$`
    // after a number, which would break `45 $` above. Documented in CLAUDE.md.
    expect(findPrices('Seats 5 $45.00 per day')).toEqual([{ amount: 5, currency: 'USD' }]);
  });

  it.each([
    ['Class C$120.00', 120, 'CAD'],
    ['Group A$99.00', 99, 'AUD'],
  ])('reads %s as a foreign currency — the other known escape', (text, amount, currency) => {
    // `C$` and `A$` are genuinely the Canadian and Australian dollar, and
    // `Class C` / `Group A` are genuinely car classes. In one text node nothing
    // tells them apart, and guessing either way is wrong somewhere. Pinned as
    // current behaviour, not endorsed: a quote landing in a phantom CAD bucket
    // is excluded from ranking rather than mis-ranked, which is the safer of
    // the two failures.
    expect(findPrices(text)).toEqual([{ amount, currency }]);
  });

  it('parses the same class and price correctly in real markup', () => {
    // Why the escape above is tolerable. Prices and labels arrive in separate
    // elements on a real page, and offerText inserts a boundary space between
    // them, so `C$` never forms. This is the claim CLAUDE.md makes for it —
    // asserted here rather than assumed.
    document.body.innerHTML = `
      <main><div class="card">
        <h3>Class C</h3><div class="p">$120.00 per day</div>
      </div></main>`;
    const offers = extractOffers(document, 'hertz');
    expect(offers).toHaveLength(1);
    expect(offers[0]?.amount).toBe(120);
    expect(offers[0]?.currency).toBe('USD');
    expect(offers[0]?.label).toBe('Class C');
  });
});

describe('the vendor selector table', () => {
  it('gives every searchable vendor a container', () => {
    // CLAUDE.md leans on these running — they scope the sweep away from nav
    // and footer. VENDOR_SELECTORS is a Partial<Record>, so adding a vendor to
    // vendors.ts silently yields no container and the sweep falls back to
    // <body>, which is the condition that lets page furniture classify a basis.
    const missing = searchableVendors()
      .filter((v) => !VENDOR_SELECTORS[v.id]?.container)
      .map((v) => v.id);
    expect(missing).toEqual([]);
  });
});

describe('currency codes written without a space', () => {
  it.each([
    ['412USD', 412, 'USD'],
    ['USD412', 412, 'USD'],
    ['USD412.00', 412, 'USD'],
    ['412.00USD', 412, 'USD'],
    ['Total: USD412.35', 412.35, 'USD'],
  ])('reads %s', (text, amount, currency) => {
    // `\b` sits between a letter and a digit, so word boundaries killed these
    // along with the Cadillac/Audi phantoms. Letter lookaround kills only the
    // phantoms.
    expect(findPrices(text)).toEqual([{ amount, currency }]);
  });

  it.each([
    '2024 Cadillac Escalade',
    '2023 Audi Q5 or similar',
    '5 audio inputs',
    '2024 Europcar fleet',
    '50 euros per day',
    '12 USDA approved',
  ])('still finds no price in %s', (text) => {
    expect(findPrices(text)).toEqual([]);
  });
});
