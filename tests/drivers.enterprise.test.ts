/**
 * @vitest-environment jsdom
 *
 * Enterprise's form driver, against a fixture built from the live form.
 *
 * The fixture mirrors what was measured on `/en/reserve.html` on 2026-08-08:
 * one visible step, a `location-search` autocomplete whose options are buttons
 * inside a `location-dropdown__*` container, a `#cid` field labelled Corporate
 * Account Number, and a "Browse Vehicles" button. It is a stand-in for a site
 * that will change, which is the same bargain `tests/extract.test.ts` makes —
 * the point is that a change to *our* code is deliberate, not that Enterprise
 * still looks like this.
 *
 * The load-bearing tests in here are the ones that pin *refusals*: a date the
 * vendor disabled, a time the dropdown does not offer, a control that reverts
 * after being set, and a return click that moves the pick-up. Each of those,
 * unnoticed, submits a search for a trip nobody asked for and reports its price
 * as the user's — which is worse than a failed quote, not better. The fixture
 * models the three calendar traps measured on the live form, so a driver that
 * stops handling one of them fails here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDates,
  applyTimes,
  calendarId,
  awaitHydration,
  enterpriseDriver,
  fillAccountNumber,
  fillLocation,
  submitSearch,
  verifyResults,
} from '../src/core/drivers/enterprise.js';
import { buildDeepLink } from '../src/core/deeplinks.js';
import { FORM_DRIVERS } from '../src/core/drivers/index.js';
import { getVendor } from '../src/core/vendors.js';
import { DriverError, type DriveContext } from '../src/core/form-driver.js';
import type { CarTrip } from '../src/core/types.js';

const TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  // Deliberately NOT noon. The fixture's selects default to `12:00 PM`, which
  // is also what the live form defaults to — so a trip at noon cannot tell
  // "the times were driven" from "the times were never touched", and deleting
  // `applyTimes` from `drive` left every test in this file green.
  pickupTime: '09:30',
  dropoffDate: '2026-09-06',
  dropoffTime: '17:00',
};

/** Verbatim from the live site, minus the airport list. */
const SUGGESTION = 'Tampa International Airport TPA Tampa, FL, 33607 US.';

interface FormOptions {
  /** Whether the booking widget has mounted. False models the 503 throttle. */
  hydrated?: boolean;
  /** What the autocomplete offers when typed into. */
  suggestion?: string | null;
  /**
   * How many `input` events the location component ignores before it listens.
   *
   * Models the live failure this driver shipped with. `awaitHydration` waits for
   * `#cid`, and a widget that has *rendered* its inputs may not yet have bound
   * their handlers — so the driver's keystroke lands on nothing. Deliberately a
   * silent drop rather than an error: there is no menu, no options and nothing
   * to wait for, which is exactly why a bare `waitFor` burned the whole budget.
   */
  deafInputs?: number;
  /** Model a component that only opens its menu for a focused field. */
  requiresFocus?: boolean;
  /** The code the visible option advertises. Defaults to the one we ask for. */
  offerCode?: string;
  /** Model the widget tearing the location field out of the document entirely. */
  locationDisappears?: boolean;
  /** Model a click the option accepts and then does nothing with. */
  selectionDoesNothing?: boolean;
  /**
   * Model the widget replacing the location input while we are nudging it.
   *
   * The same shape `cidRemountsAsync` models one field along, and the reason
   * the retry re-queries: nudging the detached node announces the value to
   * nothing, forever, while the live field sits empty.
   */
  locationRemountsAsync?: boolean;
  /** What "Browse Vehicles" does. */
  onSubmit?: 'results' | 'rejected' | 'invalid' | 'sign-in' | 'no-vehicles' | 'nothing';
  /** Render the account banner as Fortive's no-links paragraph rather than IBM's button. */
  bannerAsText?: boolean;
  /** What the results page says the rental times are; defaults to the fixture trip's. */
  resultsTimes?: string;
  /**
   * Whether the results page names a contract holder, as the live page does
   * for an applied code (`button.contract-name__button`) and does not for an
   * empty one. Defaults to true; false models a code Enterprise ignored.
   */
  resultsNameAccount?: boolean;
  /** Model a controlled input that refuses the value written to it. */
  cidRejectsValue?: boolean;
  /** Earliest month the calendar will show, `[year, monthIndex]`. Aug 2026. */
  firstMonth?: [number, number];
  /**
   * Render the trailing spillover in the *second* grid as well: the 1st of the
   * month after the displayed pair, greyed and disabled, carrying that day's
   * id. A driver that reads "present but disabled" as a refusal without asking
   * whether the day's month is on screen fails every trip starting there.
   */
  spilloverInSecondPanel?: boolean;
  /**
   * Model a grid that repaints a moment after an arrow is clicked rather than
   * synchronously — a React re-render against a 250ms poll. The next poll sees
   * the old months, and a driver that clicks again on every poll overshoots.
   */
  slowPaging?: boolean;
  /**
   * Model the pick-up calendar lingering mounted for a moment after the pick,
   * as a closing animation would, instead of unmounting on the click.
   */
  pickupCalendarLingers?: boolean;
  /** Render month headers in a form `monthKey` cannot read ("Aug 2026"). */
  shortMonthHeaders?: boolean;
  /** Dates rendered disabled in every grid — the vendor refusing a day. */
  disabledDates?: string[];
  /** Time dropdown options. Defaults to the half-hourly list, bare-hour form. */
  timeOptions?: string[];
  /**
   * Model a controlled `<select>` that reverts *asynchronously*.
   *
   * The realistic React shape, and the one a same-tick read-back cannot see:
   * the component re-renders from its own state a microtask later and throws
   * the written value away.
   */
  timeRevertsAsync?: boolean;
  /** Model a return click that also moves the pick-up, as a range picker can. */
  returnClickMovesPickup?: boolean;
  /**
   * Model the widget remounting `#cid` while we are verifying it.
   *
   * Deliberately a node *replacement* rather than an in-place clear, which is
   * what `cidRejectsValue` does. The two fail differently: a cleared field is
   * caught by any read-back, while a replaced one leaves the detached node
   * holding the value, so a check closed over the original reference sees the
   * code it wrote and reports success on a form that holds nothing.
   */
  cidRemountsAsync?: boolean;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Every half hour as Enterprise renders it, e.g. `9:30 AM`, `12:00 PM`. */
function halfHourly(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h += 1) {
    for (const m of ['00', '30']) {
      const ampm = h < 12 ? 'AM' : 'PM';
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      out.push(`${hour12}:${m} ${ampm}`);
    }
  }
  return out;
}

/**
 * The date and time controls, modelling the three behaviours that were measured
 * on the live form and that the driver exists to survive:
 *
 * 1. **A range picker.** Choosing a pick-up clears the return and closes the
 *    calendar, so the return needs a second pass.
 * 2. **Duplicate `data-test-id`s.** The first grid carries a *disabled*
 *    spillover cell for the next month's 1st, so the real cell is the second
 *    match — a driver taking the first reads a bookable date as refused.
 * 3. **`invisible`, not `disabled`.** The back arrow at the earliest month is
 *    styled out rather than disabled, so a `.disabled` test sees it as usable.
 */
function renderDateTime(host: HTMLElement, options: FormOptions): void {
  const {
    firstMonth = [2026, 7],
    disabledDates = [],
    timeOptions = halfHourly(),
    timeRevertsAsync = false,
    returnClickMovesPickup = false,
  } = options;

  const earliest = firstMonth[0] * 12 + firstMonth[1];
  let shown = earliest;
  let nextClicks = 0;
  let pickup = '';
  let ret = '';
  let open: 'pickup' | 'return' | null = null;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button id="pickupCalendarFocusable"><span class="date-wrapper"><span class="day"></span></span></button>
    <button id="dropoffCalendarFocusable"><span class="date-wrapper"><span class="day"></span></span></button>
    <select aria-label="Pick-Up Time Selector"></select>
    <select aria-label="Return Time Selector"></select>
    <div class="calendar-host"></div>
  `;
  host.append(wrap);

  for (const which of ['Pick-Up', 'Return'] as const) {
    const select = wrap.querySelector<HTMLSelectElement>(`select[aria-label^="${which}"]`)!;
    for (const value of timeOptions) {
      const option = document.createElement('option');
      option.value = value;
      option.text = value;
      select.append(option);
    }
    select.value = '12:00 PM';
    if (timeRevertsAsync) {
      select.addEventListener('change', () => {
        void Promise.resolve().then(() => {
          select.value = '12:00 PM';
        });
      });
    }
  }

  const calendarHost = wrap.querySelector<HTMLElement>('.calendar-host')!;

  function paintToggles(): void {
    wrap
      .querySelector('#pickupCalendarFocusable')!
      .setAttribute('aria-label', pickup ? `Selected Pick-Up Date ${pickup}` : '');
    wrap
      .querySelector('#dropoffCalendarFocusable')!
      .setAttribute('aria-label', ret ? `Selected Return Date ${ret}` : '');
  }

  function paintCalendar(): void {
    calendarHost.replaceChildren();
    if (!open) return;

    for (const offset of [0, 1]) {
      const key = shown + offset;
      const year = Math.floor(key / 12);
      const month = key % 12;
      const panel = document.createElement('div');

      const controls = document.createElement('div');
      controls.className = 'calendar-controls';
      const back = document.createElement('button');
      back.className = `cta calendar-control-arrow arrow-left${shown <= earliest ? ' invisible' : ''}`;
      back.setAttribute('aria-label', 'Previous Month');
      const header = document.createElement('span');
      header.className = 'calendar-control-header';
      header.textContent = options.shortMonthHeaders
        ? `${MONTH_NAMES[month]!.slice(0, 3)} ${year}`
        : `${MONTH_NAMES[month]} ${year}`;
      const forward = document.createElement('button');
      forward.className = 'cta calendar-control-arrow arrow-right';
      forward.setAttribute('aria-label', 'Next Month');
      back.addEventListener('click', () => {
        if (shown > earliest) shown -= 1;
        paintCalendar();
      });
      forward.addEventListener('click', () => {
        nextClicks += 1;
        document.body.dataset['nextClicks'] = String(nextClicks);
        shown += 1;
        if (options.slowPaging) {
          // Deep enough to land after the driver's next poll has read the
          // headers: its fake sleep resolves in one microtask.
          void Promise.resolve()
            .then(() => undefined)
            .then(() => undefined)
            .then(() => paintCalendar());
          return;
        }
        paintCalendar();
      });
      controls.append(back, header, forward);
      panel.append(controls);

      const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const cells: { id: string; dead: boolean }[] = [];
      for (let d = 1; d <= count; d += 1) {
        cells.push({ id: `${pad(month + 1)}/${pad(d)}/${year}`, dead: false });
      }
      // The spillover: next month's 1st, greyed, in this grid. The first panel
      // always gets one, as the live calendar was measured to render it; the
      // second only when a test asks, modelling a six-row grid's trailing days.
      if (offset === 0 || (offset === 1 && options.spilloverInSecondPanel)) {
        const nextKey = key + 1;
        const ny = Math.floor(nextKey / 12);
        const nm = nextKey % 12;
        cells.push({ id: `${pad(nm + 1)}/01/${ny}`, dead: true });
      }

      for (const cell of cells) {
        const button = document.createElement('button');
        button.className = `rs-calendar__day${cell.dead ? ' next-month disabled' : ''}`;
        button.setAttribute('data-test-id', cell.id);
        button.disabled = cell.dead || disabledDates.includes(cell.id);
        button.addEventListener('click', () => {
          if (open === 'pickup') {
            pickup = cell.id;
            ret = '';
          } else {
            ret = cell.id;
            // A range picker re-derives both ends from the two clicks, so
            // choosing a return can move the pick-up underneath it.
            if (returnClickMovesPickup) pickup = '01/01/2026';
          }
          const wasPickup = open === 'pickup';
          open = null;
          paintToggles();
          if (wasPickup && options.pickupCalendarLingers) {
            void Promise.resolve()
              .then(() => undefined)
              .then(() => undefined)
              .then(() => paintCalendar());
            return;
          }
          paintCalendar();
        });
        panel.append(button);
      }
      calendarHost.append(panel);
    }
  }

  for (const [id, name] of [
    ['#pickupCalendarFocusable', 'pickup'],
    ['#dropoffCalendarFocusable', 'return'],
  ] as const) {
    wrap.querySelector<HTMLElement>(id)!.addEventListener('click', () => {
      open = open === name ? null : name;
      if (open) shown = earliest;
      paintCalendar();
    });
  }

  pickup = '';
  ret = '';
  paintToggles();
}

function renderForm(options: FormOptions = {}): void {
  const {
    hydrated = true,
    suggestion = SUGGESTION,
    onSubmit = 'results',
    cidRejectsValue = false,
    resultsNameAccount = true,
    bannerAsText = false,
    resultsTimes,
  } = options;

  document.body.innerHTML = '<header>Enterprise Rent-A-Car</header>';
  if (!hydrated) return;

  const form = document.createElement('div');
  form.innerHTML = `
    <label>Pick-up &amp; Return Location</label>
    <div class="location-field"><input name="location-search" placeholder="Provide a Location" /></div>
    <input type="checkbox" id="sameLocation" />
    <ul class="location-dropdown__aria-items"></ul>
    <select id="age"><option>25+</option></select>
    <label for="cid">Corporate Account Number</label>
    <input type="text" id="cid" />
    <button type="button">Browse Vehicles</button>
  `;
  document.body.append(form);
  renderDateTime(form, options);

  const location = form.querySelector<HTMLInputElement>('input[name="location-search"]')!;
  const aria = form.querySelector<HTMLElement>('.location-dropdown__aria-items')!;
  const chipHost = form.querySelector<HTMLElement>('.location-field')!;

  /**
   * Both menus, exactly as the live form renders them (measured 2026-08-12).
   *
   * The screen-reader mirror comes **first in document order** and spaces the
   * branch name from the code; the visible list comes second and glues them
   * together inside separate elements. Reproducing both is the entire point of
   * this fixture — a single tidy menu is what let three real bugs pass.
   */
  const branch = suggestion ? suggestion.split(/\bTPA\b/)[0]!.trim() : '';
  const openMenus = (): void => {
    // The mirror: `li`s carrying the spaced text, and no click handler at all.
    const mirror = document.createElement('li');
    mirror.textContent = suggestion!;
    aria.append(mirror);

    const real = document.createElement('div');
    real.className = 'location-dropdown auto-complete';
    // Verbatim shape: li[role=option] > button > (.location-name, .airport-code).
    // The `li` is NOT clickable; only the button is.
    real.innerHTML = `
      <div class="location-group">
        <li class="location-group__item" role="option">
          <button tabindex="-1" class="cta-unstyled" data-location-type="airports">
            <span class="location-name"><span>${branch}</span></span><small
            class="airport-code">${options.offerCode ?? 'TPA'}</small><span
            class="location-group__item-city-sub-country">Tampa, FL, 33607 US</span>
          </button>
          <small class="location-group__item-select">Select</small>
        </li>
      </div>`;
    real.querySelector('button')!.addEventListener('click', () => {
      // A click the page accepts and does nothing with: both menus stay open and
      // no chip appears. The mirror staying is the point — it still renders the
      // branch name, so a readback that excludes only the visible menu passes.
      if (options.selectionDoesNothing) return;
      aria.replaceChildren();
      real.remove();
      const chip = document.createElement('span');
      chip.textContent = branch;
      chipHost.append(chip);
    });
    form.append(real);
  };

  const closeMenus = (): void => {
    aria.replaceChildren();
    form.querySelector('.location-dropdown.auto-complete')?.remove();
  };

  let deaf = options.deafInputs ?? 0;
  let remountsLeft = options.locationRemountsAsync ? 1 : 0;

  /**
   * Bind the autocomplete to a field.
   *
   * A function rather than a one-off `addEventListener` so a remount can
   * re-bind it — a React section re-render replaces the node *and* attaches
   * fresh handlers, and a fixture whose replacement is inert would fail the
   * driver for the wrong reason.
   */
  const attach = (field: HTMLInputElement): void => {
    field.addEventListener('input', () => {
      // A detached field answers nothing. React takes the handlers with the
      // node when it unmounts a section, and without this the fixture let a
      // nudge aimed at the *old* input still open the menu — which is exactly
      // the bug the retry's re-query exists to prevent, so the test for it
      // passed against code that did not have the fix.
      if (!field.isConnected) return;
      // Not even the menu is cleared while deaf — the handler is not bound yet,
      // so the event reaches nothing at all.
      if (deaf > 0) {
        deaf -= 1;
        return;
      }
      if (options.locationDisappears) {
        void Promise.resolve().then(() => field.remove());
        return;
      }
      if (remountsLeft > 0) {
        remountsLeft -= 1;
        void Promise.resolve().then(() => {
          const fresh = document.createElement('input');
          fresh.name = 'location-search';
          field.removeAttribute('name');
          field.replaceWith(fresh);
          attach(fresh);
        });
        return;
      }
      // A component that only answers a focused field. Off by default; the live
      // one was never measured either way, so this models the risk rather than
      // asserting it is real.
      if (options.requiresFocus && document.activeElement !== field) return;
      closeMenus();
      if (!field.value || !suggestion) return;
      openMenus();
    });
  };
  attach(location);

  if (cidRejectsValue) {
    const cid = form.querySelector<HTMLInputElement>('#cid')!;
    cid.addEventListener('input', () => {
      cid.value = '';
    });
  }

  if (options.cidRemountsAsync) {
    const cid = form.querySelector<HTMLInputElement>('#cid')!;
    cid.addEventListener('input', () => {
      void Promise.resolve().then(() => {
        // A fresh, empty field in the same place — the ordinary result of a
        // React section re-render. The old node keeps the value we wrote.
        const fresh = document.createElement('input');
        fresh.type = 'text';
        fresh.id = 'cid';
        cid.removeAttribute('id');
        cid.replaceWith(fresh);
      });
    });
  }

  form.querySelector('button')!.addEventListener('click', () => {
    if (onSubmit === 'results') {
      window.location.hash = '#car_select';
      // The shape measured 2026-10-26: cards in main, and the holder's name in
      // a header banner that is simply empty when no contract applied.
      const banner = document.createElement('div');
      banner.id = 'codebanner-container';
      if (resultsNameAccount) {
        banner.innerHTML = bannerAsText
          ? '<div class="code-banner code-banner--no-links"><p class="contract-name-text">FTV BUSINESS SERVICES-PERSONAL</p></div>'
          : '<button class="cta contract-name__button" aria-label="I B M CORP (USA)">I B M CORP (USA)</button>';
      }
      document.body.prepend(banner);
      const results = document.createElement('main');
      results.innerHTML =
        '<section class="car-item__wrapper"><h2>Economy</h2><div class="car-item__price-details-item"><span>$55.13</span><p>Per Day</p></div></section>';
      // The live results page restates the itinerary in its rental-details
      // step; the driver checks the times against it.
      const details = document.createElement('p');
      details.textContent =
        resultsTimes ?? 'RENTAL DETAILS Fri, Sep 4, 9:30 AM Sun, Sep 6, 5:00 PM';
      results.prepend(details);
      document.body.append(results);
    }
    const answers: Record<string, string> = {
      rejected:
        "Error: We're sorry, but this account number cannot be used online. " +
        'Please contact your account manager if you have questions.',
      invalid:
        "Error: We're sorry, but the promotion code provided for this reservation is invalid. " +
        'Please update or remove to continue.',
      'sign-in': 'Error: Please sign in to your Enterprise Plus® account to continue.',
      'no-vehicles':
        "Error: We're sorry, but no vehicles are available at this time. Please call us for assistance.",
    };
    if (answers[onSubmit]) {
      const error = document.createElement('div');
      error.textContent = answers[onSubmit];
      document.body.prepend(error);
    }
  });
}

function makeContext(overrides: Partial<DriveContext> = {}): DriveContext {
  let clock = 0;
  return {
    doc: document,
    trip: TRIP,
    code: '5666666',
    deadline: 10_000,
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
  // The submit marker is per tab and would otherwise outlive the test that
  // set it, letting a later `drive` mistake a fresh fixture for its own reload.
  window.sessionStorage.clear();
});

describe('registration', () => {
  it('is registered, so a run can reach it', () => {
    // The inverse of the gate this used to assert. Registration was withheld
    // while `applyDates` threw unconditionally; it landed in the same change
    // that measured and drove the calendar.
    expect(FORM_DRIVERS.enterprise).toBe(enterpriseDriver);
  });

  it('agrees with the deep-link builder about where the form lives', () => {
    // `deeplinks.ts` writes this URL out longhand rather than importing the
    // driver, because the driver imports *it* for `airportCode`, `clock12` and
    // `isoParts` — so the two can drift silently. Same pin National has.
    expect(buildDeepLink('enterprise', '5666666', TRIP).url).toBe(enterpriseDriver.startUrl());
  });

  it('is reachable end to end: searchable, driven, and permitted', () => {
    // Registration alone changes nothing — a driver is reached only if the
    // vendor is also `searchable: true` *and* its builder returns a URL, since
    // a throwing builder settles the quote at plan time before any lane sees
    // it. All three had to land together, so all three are asserted together.
    expect(getVendor('enterprise').searchable).toBe(true);
    expect(buildDeepLink('enterprise', '5666666', TRIP).confidence).toBe('driven');
    expect(FORM_DRIVERS.enterprise).toBeDefined();
  });

  it('asks for a longer probe budget than the default', () => {
    // Its widget took ~40s to mount on one measured load, against a 45s default
    // of which the driver gets a fraction. Without this the driver would be
    // registered, reachable, and out of time before it typed anything.
    const budget = getVendor('enterprise').probeTimeoutMs;
    expect(budget).toBeGreaterThan(45_000);
  });
});

describe('awaitHydration', () => {
  it('resolves once the widget mounts', async () => {
    renderForm({ hydrated: false });
    const context = makeContext();
    // The probe runs at document_idle and the widget is not there yet; measured
    // at roughly ten seconds on one load and forty on another.
    const promise = awaitHydration(context);
    renderForm();
    await expect(promise).resolves.toBeInstanceOf(window.HTMLInputElement);
  });

  it('blames throttling rather than the markup when it never mounts', async () => {
    renderForm({ hydrated: false });
    const error = await failureOf(awaitHydration(makeContext()));
    expect(error.failure).toBe('form-fill');
    // The two causes want opposite responses — back off, or go read the DOM —
    // so the message has to distinguish them.
    expect(error.message).toMatch(/throttling/i);
  });
});

describe('fillLocation', () => {
  it('types the airport, takes the suggestion, and confirms the form shows it', async () => {
    renderForm();
    await fillLocation(makeContext());

    const field = document.querySelector<HTMLInputElement>('input[name="location-search"]')!;
    expect(field.value).toBe('TPA');
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
  });

  it('fails when the suggestion is only ever in a dropdown', async () => {
    // The check that nearly went in wrong, twice. A menu contains the branch
    // name by construction, so a body-wide search passes here — with the form
    // holding no selection at all and the next step submitting a blank search.
    //
    // **This is also the regression test for excluding only one menu.** The
    // screen-reader mirror renders the same name, so with `textOutside` given
    // just `LOCATION_MENU` this passes on a click that selected nothing.
    renderForm({ selectionDoesNothing: true });
    const form = document.querySelector('.location-field')!;
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(form.textContent).not.toContain('Tampa International');
    // And it says *why* it looks like this, rather than only that it timed out.
    expect(error.message).toContain('menu=still-open');
    expect(error.message).toContain('aria=present');
    expect(error.message).toContain('anywhere=true');
  });

  it('clicks the option, not the role=option wrapper that swallows it', async () => {
    // National's lesson, and Enterprise's actual live failure. The `<li>` is
    // `role="option"` and has no handler; only the inner button selects. Pinned
    // by asserting the *button* is what got clicked.
    renderForm();
    const clicked: string[] = [];
    document.addEventListener(
      'click',
      (e) => clicked.push((e.target as HTMLElement).tagName),
      true,
    );
    await fillLocation(makeContext());
    expect(clicked).toContain('BUTTON');
    expect(clicked).not.toContain('LI');
  });

  it('ignores the screen-reader mirror when looking for the option', async () => {
    // The bug itself. `location-dropdown__aria-items` comes first in document
    // order, so `[class*="location-dropdown"]` matched it — and its `li`s carry
    // the same text with no handler. Deleting the `.auto-complete` scope from
    // `LOCATION_MENU` makes the driver click the mirror and this fails.
    renderForm();
    await fillLocation(makeContext());
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
  });

  it('matches the code in a tab that has layout, where the text is glued', async () => {
    // The live form renders `Tampa International AirportTPA Tampa, FL…` — no
    // separator before the code — so `hasToken` refuses it. A probe tab is
    // saved from that by accident, because with no layout `innerText` is `''`
    // and `textOf` falls back to `visibleText`, which re-spaces the text nodes.
    // jsdom never defines `innerText`, so the default fixture is always the
    // lucky case; this one supplies it, which is the *unlucky* case and the one
    // any foreground run gets.
    renderForm();
    const location = document.querySelector<HTMLInputElement>('input[name="location-search"]')!;
    const glue = (): void => {
      for (const button of document.querySelectorAll<HTMLElement>(
        '.location-dropdown.auto-complete li.location-group__item button',
      )) {
        Object.defineProperty(button, 'innerText', {
          configurable: true,
          get: () => 'Tampa International AirportTPA Tampa, FL, 33607 US',
        });
      }
    };
    location.addEventListener('input', glue);
    await fillLocation(makeContext());
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
  });

  it('refuses an option advertising a different airport', async () => {
    // The lookup answered and disagreed with us, which is a different thing
    // from answering with nothing — and the message must say which.
    renderForm({ offerCode: 'PIE' });
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toContain('menu=present');
    expect(error.message).toContain('offered=PIE');
  });

  it('keeps nudging while the lookup only ever offers somewhere else', async () => {
    // The retry is unconditional on purpose. A `heard` latch looked right and
    // was not: `setNativeValue` sets `.value` whether or not anything is
    // listening, so a menu restored from a previous search retires the retry
    // before the dropped keystroke it exists for is noticed. At a measured ~1.5s
    // lookup against a 4s interval there is nothing to protect.
    renderForm({ offerCode: 'PIE' });
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.message).toMatch(/nudges=[1-9]/);
  });

  it('nudges the live field after the widget remounts it', async () => {
    // The retry re-queries rather than closing over the original input. With
    // `const live = pickup` this hangs: every nudge announces the value to a
    // detached node while the live field sits empty.
    renderForm({ locationRemountsAsync: true });
    await fillLocation(makeContext());
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
  });

  it('reports the live field, not the one it captured before the remount', async () => {
    // `field=held` read off a detached node, while the form holds nothing, is
    // worse than no diagnostic: it inverts the inference the message invites.
    // With the widget having removed the field, the honest answer is `gone`.
    renderForm({ locationDisappears: true });
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.message).toContain('field=gone');
    expect(error.message).toContain('fields=0');
  });

  it('focuses the field before typing, so the first keystroke is enough', async () => {
    // Pinned by *cost*, not by outcome: without the initial focus the component
    // ignores the first event and only the 4s retry recovers it, so the clock
    // is what tells the two apart. `nudgeInput` focuses, so an outcome-only
    // assertion passes either way.
    renderForm({ requiresFocus: true });
    let clock = 0;
    await fillLocation(
      makeContext({
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      }),
    );
    expect(clock).toBeLessThan(4_000);
  });

  it('recovers a keystroke the location component was not yet listening for', async () => {
    // The live failure of 2026-08-12: Enterprise reported "failing to select the
    // location". `#cid` existing does not prove the location component has bound
    // its handlers, so the first `input` event lands on nothing — and with no
    // menu there is nothing for a bare `waitFor` to wait on. Deleting either the
    // retry or `nudgeInput` from `fillLocation` fails this.
    renderForm({ deafInputs: 1 });
    await fillLocation(makeContext());
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
  });

  it('reports what the page was doing when the autocomplete never answered', async () => {
    // The diagnostics are the point, not decoration: this exact timeout was
    // reported from a live run and could not be told apart from a lost
    // keystroke, a cleared field or an empty lookup.
    renderForm({ suggestion: null });
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toContain('field=held');
    expect(error.message).toContain('menu=absent');
    expect(error.message).toContain('offered=none');
    expect(error.message).toContain('widget=present');
    expect(error.message).toMatch(/nudges=[1-9]/);
  });

  it('tells a lookup that disagreed apart from one that never rendered', async () => {
    // The reviewer's finding, pinned. While `menu` matched
    // `[class*="location-dropdown"]` it also matched the screen-reader mirror,
    // which is present regardless — so `menu=absent` was unreachable and these
    // two states produced byte-identical messages.
    renderForm({ suggestion: null });
    const silent = await failureOf(fillLocation(makeContext()));
    document.body.innerHTML = '';
    renderForm({ offerCode: 'PIE' });
    const disagreed = await failureOf(fillLocation(makeContext()));
    expect(silent.message).not.toBe(disagreed.message);
    expect(silent.message).toContain('menu=absent');
    expect(disagreed.message).toContain('menu=present');
  });

  it('refuses a one-way trip rather than driving an unmeasured field', async () => {
    renderForm();
    const error = await failureOf(
      fillLocation(makeContext({ trip: { ...TRIP, dropoffLocation: 'PHL' } })),
    );
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/one-way/);
  });

  it('accepts a drop-off that merely restates the pickup', async () => {
    renderForm();
    await expect(
      fillLocation(makeContext({ trip: { ...TRIP, dropoffLocation: 'tpa' } })),
    ).resolves.toBeUndefined();
  });

  it('refuses a location that is not an airport code', async () => {
    renderForm();
    const error = await failureOf(
      fillLocation(makeContext({ trip: { ...TRIP, pickupLocation: 'Tampa Airport' } })),
    );
    // Comes from `airportCode`, wrapped so it surfaces as a driver failure
    // rather than escaping as an unrecognised throw.
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/3-letter airport code/);
  });

  it('fails when the autocomplete offers nothing', async () => {
    renderForm({ suggestion: null });
    const error = await failureOf(fillLocation(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toContain('TPA');
  });
});

describe('clickDay paging past a trailing spillover', () => {
  it('pages forward to a month whose 1st is on screen only as a dead spillover', async () => {
    // Pick-up on the 1st of the month after the two displayed ones. Its id is
    // on screen already — as the disabled spillover at the foot of the second
    // grid — and the driver used to report that as Enterprise refusing the
    // date, before ever clicking Next.
    renderForm({ firstMonth: [2026, 6], spilloverInSecondPanel: true });
    const trip = { ...TRIP, pickupDate: '2026-09-01', dropoffDate: '2026-09-03' };
    await expect(applyDates(makeContext({ trip }))).resolves.toBeUndefined();
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/01/2026');
  });

  it('still reports a refusal when the date is dead in its own month', async () => {
    renderForm({
      firstMonth: [2026, 6],
      spilloverInSecondPanel: true,
      disabledDates: ['09/01/2026'],
    });
    const trip = { ...TRIP, pickupDate: '2026-09-01', dropoffDate: '2026-09-03' };
    const error = await failureOf(applyDates(makeContext({ trip })));
    expect(error.message).toMatch(/will not accept the pick-up date 09\/01\/2026/);
  });
});

describe('clickDay against a slow repaint', () => {
  it('clicks an arrow once per redraw, never once per poll', async () => {
    // Oct 2026 from a Jul/Aug display is two pages away, and the fixture —
    // like the live calendar — reopens at the earliest month for the return
    // pass, so a clean drive is exactly two clicks per pass. A driver that
    // clicks on every poll in which the cell is absent clicks again before
    // the first repaint has landed, overshoots, and pages back; the count is
    // the pin.
    renderForm({ firstMonth: [2026, 6], slowPaging: true });
    const trip = { ...TRIP, pickupDate: '2026-10-05', dropoffDate: '2026-10-07' };
    await expect(applyDates(makeContext({ trip }))).resolves.toBeUndefined();
    expect(document.body.dataset['nextClicks']).toBe('4');
  });
});

describe('applyDates when the pick-up calendar lingers', () => {
  it('waits for it to close before opening the return calendar', async () => {
    // Without the wait the return toggle is never clicked — a day cell is
    // still on screen — and the return day is clicked into the pick-up grid,
    // moving the pick-up and failing the final trip check.
    renderForm({ pickupCalendarLingers: true });
    await expect(applyDates(makeContext())).resolves.toBeUndefined();
    const label = (toggle: string) =>
      document.querySelector(toggle)?.getAttribute('aria-label') ?? '';
    expect(label('#pickupCalendarFocusable')).toContain('09/04/2026');
    expect(label('#dropoffCalendarFocusable')).toContain('09/06/2026');
  });
});

describe('clickDay with unreadable month headers', () => {
  it('fails quickly and says what the headers held', async () => {
    // A renamed or reformatted header used to be waited on until the deadline
    // and reported as "timed out reaching", which says nothing about why.
    renderForm({ firstMonth: [2026, 6], shortMonthHeaders: true });
    const trip = { ...TRIP, pickupDate: '2026-10-05', dropoffDate: '2026-10-07' };
    const ctx = makeContext({ trip, deadline: 60_000 });
    const error = await failureOf(applyDates(ctx));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/no readable month header/);
    expect(error.message).toContain('Jul 2026');
    expect(ctx.now()).toBeLessThan(10_000);
  });
});

describe('calendarId', () => {
  it('converts ISO to Enterprise’s US ordering', () => {
    // Pinned separately from the calendar because a transposed month and day is
    // silent: 04/09 and 09/04 are both real dates, both bookable, five months
    // apart. Deliberately a date where the two differ.
    expect(calendarId('2026-09-04')).toBe('09/04/2026');
  });

  it('rejects anything that is not yyyy-mm-dd', () => {
    expect(() => calendarId('09/04/2026')).toThrow();
  });
});

describe('applyDates', () => {
  // These replace a test that pinned `applyDates` always refusing. That was a
  // pin on an admission — the date control was unmeasured — and the note on it
  // said it would be replaced by tests that set a date and read it back rather
  // than deleted. This is that replacement.

  it('sets both ends of the trip and reads them back', async () => {
    renderForm();
    await applyDates(makeContext());
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/04/2026');
    expect(
      document.querySelector('#dropoffCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/06/2026');
  });

  it('survives the range picker clearing the return', async () => {
    // The measured behaviour, and the trap National's first driver fell into:
    // choosing a pick-up blanks the return. A driver that set the pick-up,
    // verified it and stopped would submit with no return date at all. The
    // fixture models the clearing, so this fails if the second pass is dropped.
    renderForm();
    await applyDates(makeContext());
    const ret = document.querySelector('#dropoffCalendarFocusable')?.getAttribute('aria-label');
    expect(ret).toBeTruthy();
    expect(ret).toContain('09/06/2026');
  });

  it('takes the enabled cell when a date appears twice', async () => {
    // September 1st renders twice: greyed at the foot of August's grid and live
    // in September's. `querySelector` returns the dead one first, and taking it
    // reports a bookable date as refused. Trip deliberately starts on the 1st.
    renderForm();
    const trip: CarTrip = { ...TRIP, pickupDate: '2026-09-01', dropoffDate: '2026-09-03' };
    await applyDates(makeContext({ trip }));
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/01/2026');
  });

  it('pages forward to a month the calendar does not start on', async () => {
    // Opens on August + September; an October trip is simply not on screen.
    // This is the case that burned National's whole drive budget.
    renderForm();
    const trip: CarTrip = { ...TRIP, pickupDate: '2026-10-15', dropoffDate: '2026-10-19' };
    await applyDates(makeContext({ trip }));
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('10/15/2026');
  });

  it('catches a return click that moves the pick-up underneath it', async () => {
    // Why the final check reads *both* toggles rather than just the return.
    // The widget re-derives the range from the two clicks, so choosing the
    // return can move the pick-up — and a driver that verified only the end it
    // had just set would submit a trip starting somewhere else entirely.
    // Dropping the pick-up half of that condition left every test here green.
    renderForm({ returnClickMovesPickup: true });
    const error = await failureOf(applyDates(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/the trip 09\/04\/2026\.\.09\/06\/2026/);
  });

  it('refuses a date the vendor has disabled, rather than paging forever', async () => {
    renderForm({ disabledDates: ['09/04/2026'] });
    const error = await failureOf(applyDates(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/will not accept/);
    expect(error.message).toContain('09/04/2026');
  });

  it('gives up rather than paging past a back arrow that is styled out', async () => {
    // `invisible`, not `disabled` — the distinction this driver was written
    // around. A trip before the earliest month cannot be reached, and the
    // failure must say so instead of clicking a dead control until the deadline.
    renderForm({ firstMonth: [2026, 8] });
    const trip: CarTrip = { ...TRIP, pickupDate: '2026-07-04', dropoffDate: '2026-07-06' };
    const error = await failureOf(applyDates(makeContext({ trip })));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/will not page previous/);
  });
});

describe('fillAccountNumber', () => {
  it('catches a field that is remounted while we verify it', async () => {
    // The highest-stakes field on the form, and the subtlest way to get it
    // wrong. Reading back through the reference we wrote to verifies a node
    // that may already be detached: it still holds the code while the live
    // field is empty. The driver reports success, the form submits with no
    // account number, and Enterprise answers with the *retail* rate — reported
    // to the user as their company's discounted price.
    //
    // This is why the read-back re-queries `#cid` every poll rather than
    // closing over it. Closing over it passes this test's fixture happily.
    renderForm({ cidRemountsAsync: true });
    const error = await failureOf(fillAccountNumber(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/account number field to keep the code/);
  });
});

describe('applyTimes', () => {
  it('sets both times and reads them back', async () => {
    renderForm();
    const trip: CarTrip = { ...TRIP, pickupTime: '09:30', dropoffTime: '17:00' };
    await applyTimes(makeContext({ trip }));
    const value = (which: string) =>
      document.querySelector<HTMLSelectElement>(`select[aria-label^="${which}"]`)?.value;
    expect(value('Pick-Up')).toBe('9:30 AM');
    expect(value('Return')).toBe('5:00 PM');
  });

  it('accepts a zero-padded option list too', async () => {
    // Only `12:00 PM` was ever seen on the live form, which says nothing about
    // whether nine in the morning is `9:00 AM` or `09:00 AM`. Both are matched
    // on purpose; this pins the half that was not measured.
    renderForm({ timeOptions: ['09:30 AM', '12:00 PM'] });
    const trip: CarTrip = { ...TRIP, pickupTime: '09:30', dropoffTime: '12:00' };
    await applyTimes(makeContext({ trip }));
    expect(document.querySelector<HTMLSelectElement>('select[aria-label^="Pick-Up"]')?.value).toBe(
      '09:30 AM',
    );
  });

  it('catches a control that reverts after we set it', async () => {
    // The failure `applyTimes` exists to prevent, and the one a same-tick
    // read-back cannot see: `setNativeValue` makes `select.value` correct
    // immediately, so checking on that tick tests our own assignment. A React
    // select that re-renders from its own state a microtask later then throws
    // the value away, the check has already passed, and noon is submitted as
    // the user's trip — a real page, a real number, the wrong rental.
    renderForm({ timeRevertsAsync: true });
    const error = await failureOf(applyTimes(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/time control to keep/);
  });

  it('refuses a time the dropdown does not offer', async () => {
    // Half-hourly, so 09:15 has no option. Rounding it silently would rent the
    // car for a different span than the one asked for — the same lie the dates
    // refused to tell.
    renderForm();
    const trip: CarTrip = { ...TRIP, pickupTime: '09:15' };
    const error = await failureOf(applyTimes(makeContext({ trip })));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/different span/);
  });

  it('leaves the form alone when the trip time is malformed', async () => {
    renderForm();
    const trip: CarTrip = { ...TRIP, pickupTime: '25:00' };
    const error = await failureOf(applyTimes(makeContext({ trip })));
    expect(error.failure).toBe('form-fill');
  });
});

describe('fillAccountNumber', () => {
  it('puts the code in the Corporate Account Number field', async () => {
    renderForm();
    await fillAccountNumber(makeContext());
    expect(document.querySelector<HTMLInputElement>('#cid')!.value).toBe('5666666');
  });

  it('fails when a controlled field throws the value away', async () => {
    // Without the read-back this submits with no code and prices the retail
    // rate, which then gets reported as the company's discounted one.
    renderForm({ cidRejectsValue: true });
    const error = await failureOf(fillAccountNumber(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/keep the code/);
  });

  it('fails when the field is missing entirely', async () => {
    renderForm();
    document.querySelector('#cid')!.remove();
    const error = await failureOf(fillAccountNumber(makeContext()));
    expect(error.failure).toBe('form-fill');
  });
});

describe('submitSearch', () => {
  it('resolves once the results hash appears', async () => {
    renderForm({ onSubmit: 'results' });
    await expect(submitSearch(makeContext())).resolves.toBeUndefined();
    expect(window.location.hash).toBe('#car_select');
  });

  it('reports an invalid promotion code in the vendor’s words, without remembering it', async () => {
    renderForm({ onSubmit: 'invalid' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('discount-missing');
    expect(error.message).toMatch(/promotion code/i);
  });

  it('reports a code that needs an Enterprise Plus sign-in without remembering it', async () => {
    // The vendor's verdict on the session, not the code: a user who signs in
    // would have it price next run, so it must not land in the refused list.
    renderForm({ onSubmit: 'sign-in' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('discount-missing');
    expect(error.message).toMatch(/sign-in/i);
  });

  it('reports "no vehicles available" as an empty answer, not a refusal', async () => {
    // Purdue's code, 2026-10-27: National priced it the same minute, so this
    // is availability under the contract rather than a verdict on the code —
    // and must not be remembered the way `code-rejected` is.
    renderForm({ onSubmit: 'no-vehicles' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('probe-empty');
    expect(error.message).toMatch(/no vehicles/i);
  });

  it('reports the vendor refusing the code as its own outcome', async () => {
    renderForm({ onSubmit: 'rejected' });
    const error = await failureOf(submitSearch(makeContext()));
    // Not form-submit: nothing broke. The form worked, the submission worked,
    // and Enterprise said no — which is a fact about the code worth telling the
    // user plainly.
    expect(error.failure).toBe('code-rejected');
    expect(error.message).toMatch(/cannot be used online/i);
  });

  it('reports form-submit when the search simply never answers', async () => {
    renderForm({ onSubmit: 'nothing' });
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('form-submit');
  });

  it('fails at fill, not submit, when the button is missing', async () => {
    renderForm();
    document.querySelector('button')!.remove();
    const error = await failureOf(submitSearch(makeContext()));
    // The page was never asked for a price, so this is the fill end even though
    // it happens in the submit step.
    expect(error.failure).toBe('form-fill');
  });
});

describe('verifyResults', () => {
  it('passes a results page that names the contract holder', async () => {
    renderForm({ onSubmit: 'results' });
    document.querySelector('button')!.click();
    // And reports who, for the quote's evidence line.
    await expect(verifyResults(makeContext())).resolves.toEqual({ account: 'I B M CORP (USA)' });
  });

  it('fails wrong-trip when the results page shows times other than the ones driven', async () => {
    // A controlled select that reverted after the read-back would submit the
    // noon default; the results page is the only place that shows it.
    renderForm({ onSubmit: 'results', resultsTimes: 'Fri, Sep 4, 12:00 PM Sun, Sep 6, 12:00 PM' });
    document.querySelector('button')!.click();
    const error = await failureOf(verifyResults(makeContext()));
    expect(error.failure).toBe('wrong-trip');
    expect(error.message).toMatch(/09:30|17:00/);
  });

  it('does not let a hidden template retire a code for good', async () => {
    // `visibleText` reads hidden nodes; the remembered verdict is confirmed
    // against rendered text first. jsdom has no layout, so `innerText` is
    // undefined and `textOf` falls back to `visibleText` — make the template
    // invisible to both by putting the sentence in an attribute instead.
    renderForm({ onSubmit: 'nothing' });
    const template = document.createElement('div');
    template.setAttribute('data-msg', 'this account number cannot be used online');
    document.body.prepend(template);
    const error = await failureOf(submitSearch(makeContext()));
    expect(error.failure).toBe('form-submit');
  });

  it('accepts the no-links banner, where the name is a paragraph rather than a button', async () => {
    // Fortive's XZ15CH7, 2026-10-27: the page named the account in its header
    // and the button-only selector failed the quote `discount-missing`.
    renderForm({ onSubmit: 'results', bannerAsText: true });
    document.querySelector('button')!.click();
    await expect(verifyResults(makeContext())).resolves.toEqual({
      account: 'FTV BUSINESS SERVICES-PERSONAL',
    });
  });

  it('reads a vendor answer that lands after submit as that answer', async () => {
    renderForm({ onSubmit: 'nothing' });
    const error = document.createElement('div');
    error.textContent = "Error: We're sorry, but no vehicles are available at this time.";
    document.body.prepend(error);
    const failure = await failureOf(verifyResults(makeContext()));
    expect(failure.failure).toBe('probe-empty');
  });

  it('fails discount-missing when cars are listed under no account', async () => {
    // The one failure the driver could not otherwise see: a code Enterprise
    // ignores prices the retail rate on a real results page. Measured — the
    // no-code search renders the banner container empty and the cards without
    // their "Custom Rate" tag, at the very same $55.13.
    renderForm({ onSubmit: 'results', resultsNameAccount: false });
    document.querySelector('button')!.click();
    const ctx = makeContext({ deadline: 60_000 });
    const error = await failureOf(verifyResults(ctx));
    expect(error.failure).toBe('discount-missing');
    expect(error.message).toMatch(/name the account/i);
    // Decided within the banner's grace, not at the quote's deadline: a
    // silently-ignored code should cost seconds, not the whole budget.
    expect(ctx.now()).toBeLessThan(ctx.deadline);
    expect(ctx.now()).toBeLessThanOrEqual(10_250);
  });

  it('is form-submit, not discount-missing, when no results ever appear', async () => {
    renderForm({ onSubmit: 'nothing' });
    document.querySelector('button')!.click();
    const error = await failureOf(verifyResults(makeContext()));
    expect(error.failure).toBe('form-submit');
  });

  it('never outlives the quote waiting for the banner', async () => {
    // The grace is capped by the deadline, not added to it.
    renderForm({ onSubmit: 'results', resultsNameAccount: false });
    document.querySelector('button')!.click();
    const ctx = makeContext({ deadline: 1_000 });
    const error = await failureOf(verifyResults(ctx));
    expect(error.failure).toBe('discount-missing');
    expect(ctx.now()).toBeLessThanOrEqual(1_250);
  });
});

describe('drive', () => {
  it('drives nothing on a results view this tab submitted for this code', async () => {
    // The probe re-runs on every document and Enterprise's results view shares
    // the form's path, so a reload of the results page would otherwise wait
    // the whole budget for a `#cid` that view never renders. The marker is
    // what `submitSearch` leaves behind before it clicks.
    renderForm({ onSubmit: 'results' });
    let released = false;
    await submitSearch(makeContext());
    const cid = document.querySelector<HTMLInputElement>('#cid')!;
    cid.value = '';
    await expect(
      enterpriseDriver.drive(makeContext({ releasePaint: () => (released = true) })),
    ).resolves.toBeUndefined();
    expect(cid.value).toBe('');
    expect(released).toBe(true);
  });

  it('drives a results view that was not its own search, and fails loudly on it', async () => {
    // A `#car_select` this tab did not earn — restored session state, the
    // previous quote's search, the user's own — is driven from the top like
    // any other document, and a view without a form fails rather than being
    // priced under this code with a "form filled" badge.
    renderForm({ onSubmit: 'results' });
    await submitSearch(makeContext({ code: 'XZOTHER' }));
    document.querySelector('#cid')!.remove();
    const ctx = makeContext();
    const error = await failureOf(enterpriseDriver.drive(ctx));
    expect(error.failure).toBe('form-fill');
    // And says what it saw, at once — not "hydrate (it may be throttling us)"
    // after waiting out the drive budget for a field this view never renders.
    expect(error.message).toMatch(/did not search/);
    expect(ctx.now()).toBeLessThan(2_000);
  });

  it('reads a vendor answer that lands on the results view before any card', async () => {
    renderForm({ onSubmit: 'nothing' });
    window.location.hash = '#car_select';
    const error = document.createElement('div');
    error.textContent = "Error: We're sorry, but this account number cannot be used online.";
    document.body.prepend(error);
    const failure = await failureOf(verifyResults(makeContext()));
    expect(failure.failure).toBe('code-rejected');
  });

  it('drives the whole form and submits', async () => {
    // This replaces a test asserting the drive *stopped* at the dates, which
    // was correct while `applyDates` refused by design. It now runs end to end.
    renderForm({ onSubmit: 'results' });
    await enterpriseDriver.drive(makeContext());

    expect(window.location.hash).toBe('#car_select');
    expect(document.querySelector<HTMLInputElement>('#cid')?.value).toBe('5666666');
    // The location, for the same reason the times are asserted below: without
    // this the whole test passed with `fillLocation` deleted from `drive`, which
    // is the one step that had actually broken in production.
    expect(document.querySelector('.location-field')!.textContent).toContain(
      'Tampa International Airport',
    );
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/04/2026');
    // The times too, and this is the half that was missing: with the trip at
    // noon these read the fixture's own default and passed with `applyTimes`
    // deleted from `drive` entirely.
    const timeOf = (which: string) =>
      document.querySelector<HTMLSelectElement>(`select[aria-label^="${which}"]`)?.value;
    expect(timeOf('Pick-Up')).toBe('9:30 AM');
    expect(timeOf('Return')).toBe('5:00 PM');
  });

  it('holds the painted window until the search is submitted', async () => {
    // Only the *mount* was measured as needing a painted tab. The autocomplete
    // menu and the calendar are lazily-rendered popups on the same page and may
    // need one too, so releasing at hydration would move the identical failure
    // one step later — and finding that out costs a live run. Pinned by
    // ordering rather than by a flag, since "after the mount" and "after the
    // submit" both look like a single call site.
    let releasedAt: string | null = null;
    renderForm({ onSubmit: 'results' });
    await enterpriseDriver.drive(
      makeContext({
        releasePaint: () => {
          releasedAt = window.location.hash;
        },
      }),
    );
    expect(releasedAt).toBe('#car_select');
  });

  it('does not release the painted window when the drive fails', async () => {
    // A quote that dies mid-fill must not report that it is finished with the
    // window on its own account — `finishQuote` is what releases it then, so
    // the two paths cannot both claim it and disagree.
    let released = false;
    renderForm({ onSubmit: 'results', disabledDates: ['09/04/2026'] });
    await failureOf(enterpriseDriver.drive(makeContext({ releasePaint: () => (released = true) })));
    expect(released).toBe(false);
  });

  it('never submits a form whose trip it could not express', async () => {
    // The invariant the old test was really protecting, kept now that the dates
    // succeed: whatever fails, the search must not be sent. Ordering the
    // itinerary steps before the submit is what guarantees it, so this fails if
    // anyone reorders `drive`.
    renderForm({ onSubmit: 'results', disabledDates: ['09/04/2026'] });
    const error = await failureOf(enterpriseDriver.drive(makeContext()));

    expect(error.failure).toBe('form-fill');
    expect(window.location.hash).toBe('');
    // And the code was never typed either — a half-driven form leaks nothing.
    expect(document.querySelector<HTMLInputElement>('#cid')?.value).toBe('');
  });

  it('opens the reservation page, which carries no itinerary', () => {
    // A driver's URL is not a deep link — nothing about the search is in it,
    // which is exactly why Enterprise needs driving.
    expect(enterpriseDriver.startUrl()).toBe('https://www.enterprise.com/en/reserve.html');
    expect(enterpriseDriver.startUrl()).not.toContain('?');
  });
});
