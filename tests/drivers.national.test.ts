/**
 * @vitest-environment jsdom
 *
 * National's form driver, against a fixture built from the live form.
 *
 * The fixture reproduces the two behaviours that actually cost debugging time on
 * the real site, because a fixture that only models the happy path would have
 * let both bugs through:
 *
 * - the autocomplete offers **nothing** while a location chip is present, which
 *   is why `clearStaleLocation` exists and why a stale-state start is a test
 *   here rather than a comment;
 * - only `button.search-autocomplete__result` is clickable — the `<li>` around
 *   it renders identical text and swallows the click.
 *
 * The load-bearing test is `reports code-rejected when the results page names no
 * account`. National will happily return a real results page at the retail rate
 * with no discount applied; that was the measured control run, and reporting it
 * as a company's rate is the failure this codebase exists to refuse.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDates,
  calendarLabels,
  clearStaleLocation,
  fillAccountNumber,
  fillLocation,
  nationalDriver,
  setDate,
  submitSearch,
  timeIndex,
} from '../src/core/drivers/national.js';
import { buildDeepLink } from '../src/core/deeplinks.js';
import { FORM_DRIVERS } from '../src/core/drivers/index.js';
import { DriverError, type DriveContext } from '../src/core/form-driver.js';
import { getVendor } from '../src/core/vendors.js';
import type { CarTrip } from '../src/core/types.js';

const TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '12:00',
  dropoffDate: '2026-09-06',
  dropoffTime: '12:00',
};

/** Verbatim from the live suggestion list. */
const SUGGESTION = 'Tampa International Airport (TPA) Tampa, FL 33607, US';

interface FormOptions {
  /** Start with a location left over from an earlier search, as the live site does. */
  staleLocation?: boolean;
  /** Start with another code in the account field — the contamination case. */
  staleCode?: string;
  /** Days the calendar refuses. */
  disabledDays?: string[];
  /** Which months the calendar renders. */
  months?: string[];
  onSubmit?: 'results-with-account' | 'results-no-account' | 'no-interstitial';
}

function renderForm(options: FormOptions = {}): void {
  const {
    staleLocation = false,
    staleCode = '',
    disabledDays = [],
    months = ['September 2026', 'October 2026'],
    onSubmit = 'results-with-account',
  } = options;

  document.body.innerHTML = '';
  const form = document.createElement('div');
  const times = Array.from(
    { length: 48 },
    (_, i) => `<option value="${i}">slot ${i}</option>`,
  ).join('');
  form.innerHTML = `
    <div class="search-autocomplete">
      <input id="search-autocomplete__input-PICKUP" />
      <button class="input-container__btn search-autocomplete__one-way-toggle">DIFFERENT RETURN</button>
    </div>
    <button class="select-pseudo" id="date-time__pickup-toggle" role="combobox"><span>Date</span></button>
    <select id="PICKUP">${times}</select>
    <button class="select-pseudo" id="date-time__return-toggle" role="combobox"><span>Date</span></button>
    <select id="RETURN">${times}</select>
    <select id="age-selector"><option value="25">25+</option></select>
    <button class="input-container__btn contract-promo__tog">ACCOUNT NUMBER / COUPONS</button>
    <div id="account-panel"></div>
    <div id="calendar-host"></div>
    <button class="btn booking-widget__go-cta">CHECK AVAILABILITY</button>
  `;
  document.body.append(form);

  const widget = form.querySelector<HTMLElement>('.search-autocomplete')!;
  const input = form.querySelector<HTMLInputElement>('#search-autocomplete__input-PICKUP')!;

  const addChip = (): void => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'Tampa International Airport (TPA)';
    const remove = document.createElement('button');
    remove.className = 'input-pseudo__close-btn';
    remove.textContent = 'Remove Location';
    remove.addEventListener('click', () => {
      chip.remove();
      remove.remove();
      input.value = '';
    });
    widget.append(chip, remove);
  };
  if (staleLocation) addChip();

  input.addEventListener('input', () => {
    widget.querySelectorAll('.results-menu').forEach((e) => e.remove());
    // The measured behaviour: a chip suppresses suggestions entirely.
    if (widget.querySelector('.input-pseudo__close-btn') || !input.value) return;
    const menu = document.createElement('ul');
    menu.className = 'results-menu';
    const dead = document.createElement('li');
    dead.textContent = SUGGESTION; // renders the same text, swallows clicks
    const real = document.createElement('button');
    real.className = 'search-autocomplete__result';
    real.textContent = SUGGESTION;
    real.addEventListener('click', () => {
      menu.remove();
      addChip();
    });
    menu.append(dead, real);
    widget.append(menu);
  });

  const host = form.querySelector<HTMLElement>('#calendar-host')!;
  for (const toggleId of ['date-time__pickup-toggle', 'date-time__return-toggle']) {
    const toggle = form.querySelector<HTMLElement>(`#${toggleId}`)!;
    toggle.addEventListener('click', () => {
      host.replaceChildren();
      for (const monthYear of months) {
        const wrapper = document.createElement('div');
        wrapper.className = 'date-selector__month-wrapper';
        // Leading space, exactly as the live site emits it.
        wrapper.setAttribute('aria-label', ` Calendar - ${monthYear} `);
        const monthName = monthYear.split(' ')[0]!;
        for (let day = 1; day <= 28; day += 1) {
          const label = `${monthName} ${day}`;
          const cell = document.createElement('button');
          cell.className = 'date-selector__day';
          cell.setAttribute('aria-label', label);
          cell.disabled = disabledDays.includes(label);
          cell.addEventListener('click', () => {
            toggle.textContent = `${monthName.slice(0, 3)} ${day}`;
            host.replaceChildren();
          });
          wrapper.append(cell);
        }
        host.append(wrapper);
      }
    });
  }

  const panel = form.querySelector<HTMLElement>('#account-panel')!;
  const openPanel = (): void => {
    if (panel.querySelector('#contract__input')) return;
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'contract__input';
    field.value = staleCode;
    panel.append(field);
  };
  form.querySelector<HTMLElement>('.contract-promo__tog')!.addEventListener('click', openPanel);
  if (staleCode) openPanel();

  form.querySelector<HTMLElement>('.booking-widget__go-cta')!.addEventListener('click', () => {
    if (onSubmit === 'no-interstitial') return;
    const guest = document.createElement('button');
    guest.textContent = 'Continue as Guest';
    guest.addEventListener('click', () => {
      guest.remove();
      window.location.hash = '#/car_select';
      const summary = document.createElement('div');
      summary.textContent =
        onSubmit === 'results-with-account'
          ? 'ACCOUNT NAME I B M CORP (USA) 34 Results Custom Rate $ 70.30 / day'
          : '34 Results $ 74.00 / day';
      document.body.prepend(summary);
    });
    document.body.prepend(guest);
  });
}

function makeContext(overrides: Partial<DriveContext> = {}): DriveContext {
  let clock = 0;
  return {
    doc: document,
    trip: TRIP,
    code: '5666666',
    deadline: 20_000,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<DriverError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DriverError);
  return error as DriverError;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('registration', () => {
  it('is registered, and the vendor it drives is reachable', () => {
    // All three have to be true for a run to reach this driver, and each was a
    // separate gate: registered here, `searchable` in vendors.ts, and a builder
    // that returns a URL rather than throwing — `makeQuote` catches a throw and
    // settles the quote before any lane sees it.
    expect(FORM_DRIVERS.national).toBe(nationalDriver);
    expect(getVendor('national').searchable).toBe(true);
    expect(buildDeepLink('national', '5666666', TRIP).url).toBe(nationalDriver.startUrl());
  });

  it('is held to one tab at a time, because its session state is shared', () => {
    expect(getVendor('national').maxLanes).toBe(1);
  });
});

describe('calendarLabels', () => {
  it('names the month and day the calendar uses', () => {
    expect(calendarLabels('2026-09-04')).toEqual({ month: 'September 2026', day: 'September 4' });
  });

  it('drops the leading zero, as the aria-label does', () => {
    expect(calendarLabels('2026-01-07').day).toBe('January 7');
  });

  it('does not shift the day for a west-of-UTC clock', () => {
    // `new Date('2026-09-01')` is parsed as UTC and renders as August 31 for
    // anyone in the Americas — a whole day wrong, silently, on the first of
    // every month.
    expect(calendarLabels('2026-09-01')).toEqual({ month: 'September 2026', day: 'September 1' });
  });

  it('refuses a date it cannot parse', () => {
    expect(() => calendarLabels('04/09/2026')).toThrow();
  });
});

describe('timeIndex', () => {
  it('maps a time onto National half-hour slots', () => {
    // 24 is "12:00 PM" and 23 is "11:30 AM" on the live form.
    expect(timeIndex('12:00')).toBe('24');
    expect(timeIndex('11:30')).toBe('23');
    expect(timeIndex('00:00')).toBe('0');
    expect(timeIndex('23:30')).toBe('47');
  });

  it('refuses a malformed time rather than searching midnight', () => {
    expect(() => timeIndex('noon')).toThrow();
    expect(() => timeIndex('25:00')).toThrow();
  });
});

describe('clearStaleLocation', () => {
  it('removes a chip left by an earlier search', async () => {
    renderForm({ staleLocation: true });
    await clearStaleLocation(makeContext());
    expect(document.querySelector('.input-pseudo__close-btn')).toBeNull();
  });

  it('does nothing on a cold form', async () => {
    renderForm();
    await expect(clearStaleLocation(makeContext())).resolves.toBeUndefined();
  });
});

describe('fillLocation', () => {
  it('types the airport, takes the suggestion, and confirms the chip', async () => {
    renderForm();
    await fillLocation(makeContext());
    expect(document.querySelector('.search-autocomplete')!.textContent).toContain('(TPA)');
  });

  it('works from a form still holding the previous search', async () => {
    // The regression that matters. With the chip present the autocomplete offers
    // nothing, so without the clear this times out — and on the live site that
    // looked like the markup had changed rather than like stale state.
    renderForm({ staleLocation: true });
    await fillLocation(makeContext());
    expect(document.querySelector('.search-autocomplete')!.textContent).toContain('(TPA)');
  });

  it('clicks the button, not the identical-looking li', async () => {
    renderForm();
    let liClicks = 0;
    document.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).tagName === 'LI') liClicks += 1;
    });
    await fillLocation(makeContext());
    expect(liClicks).toBe(0);
  });

  it('refuses a one-way trip', async () => {
    renderForm();
    const error = await failureOf(
      fillLocation(makeContext({ trip: { ...TRIP, dropoffLocation: 'PHL' } })),
    );
    expect(error.message).toMatch(/one-way/);
  });

  it('refuses a location that is not an airport code', async () => {
    renderForm();
    const error = await failureOf(
      fillLocation(makeContext({ trip: { ...TRIP, pickupLocation: 'Tampa' } })),
    );
    expect(error.failure).toBe('form-fill');
  });
});

describe('setDate and applyDates', () => {
  it('picks the day and confirms the field reads it back', async () => {
    renderForm();
    await setDate(makeContext(), 'date-time__pickup-toggle', '2026-09-04', 'pick-up');
    expect(document.querySelector('#date-time__pickup-toggle')!.textContent).toBe('Sep 4');
  });

  it('says so when the calendar refuses that day', async () => {
    renderForm({ disabledDays: ['September 4'] });
    const error = await failureOf(
      setDate(makeContext(), 'date-time__pickup-toggle', '2026-09-04', 'pick-up'),
    );
    expect(error.failure).toBe('form-fill');
    // Distinct from "no such cell": a disabled day is the site declining, and
    // the two want different fixes.
    expect(error.message).toMatch(/will not accept/);
  });

  it('fails when the month is not on screen', async () => {
    renderForm({ months: ['September 2026'] });
    const error = await failureOf(
      setDate(makeContext(), 'date-time__return-toggle', '2026-12-02', 'return'),
    );
    expect(error.message).toContain('December 2026');
  });

  it('sets both dates and both times', async () => {
    renderForm();
    await applyDates(makeContext());
    expect(document.querySelector('#date-time__pickup-toggle')!.textContent).toBe('Sep 4');
    expect(document.querySelector('#date-time__return-toggle')!.textContent).toBe('Sep 6');
    expect(document.querySelector<HTMLSelectElement>('#PICKUP')!.value).toBe('24');
    expect(document.querySelector<HTMLSelectElement>('#RETURN')!.value).toBe('24');
  });
});

describe('fillAccountNumber', () => {
  it('opens the panel and types the code', async () => {
    renderForm();
    await fillAccountNumber(makeContext());
    expect(document.querySelector<HTMLInputElement>('#contract__input')!.value).toBe('5666666');
  });

  it('overwrites a code left behind by an earlier run', async () => {
    // Measured on the live site: reloading the form kept `5666666` in the field
    // and the toggle still named IBM. A driver that appended, or that skipped a
    // populated field, would price another company's code under this one's name.
    renderForm({ staleCode: 'XZ15J55' });
    await fillAccountNumber(makeContext());
    expect(document.querySelector<HTMLInputElement>('#contract__input')!.value).toBe('5666666');
  });
});

describe('submitSearch', () => {
  it('clears the guest interstitial and accepts a discounted results page', async () => {
    renderForm({ onSubmit: 'results-with-account' });
    await expect(submitSearch(makeContext())).resolves.toBeUndefined();
    expect(window.location.hash).toBe('#/car_select');
  });

  it('reports code-rejected when the results page names no account', async () => {
    // The control run, exactly: a real results page, real prices, no discount.
    // Those are retail rates, and letting them through would report them as the
    // company's — a real page, a real number, the wrong answer.
    renderForm({ onSubmit: 'results-no-account' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('code-rejected');
    expect(window.location.hash).toBe('#/car_select');
  });

  it('reports form-submit when the interstitial never appears', async () => {
    renderForm({ onSubmit: 'no-interstitial' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('form-submit');
  });
});

describe('drive', () => {
  it('runs the whole form from stale state to a discounted results page', async () => {
    renderForm({ staleLocation: true, staleCode: 'XZ15J55', onSubmit: 'results-with-account' });
    await expect(nationalDriver.drive(makeContext())).resolves.toBeUndefined();

    expect(document.querySelector('.search-autocomplete')!.textContent).toContain('(TPA)');
    expect(document.querySelector('#date-time__pickup-toggle')!.textContent).toBe('Sep 4');
    expect(document.querySelector<HTMLInputElement>('#contract__input')!.value).toBe('5666666');
    expect(window.location.hash).toBe('#/car_select');
  });

  it('opens the form page, which carries no itinerary', () => {
    expect(nationalDriver.startUrl()).toBe('https://www.nationalcar.com/en/home.html');
    expect(nationalDriver.startUrl()).not.toContain('?');
  });
});
