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
 * The load-bearing test in here is the one asserting the driver **fails**:
 * `applyDates` is unimplemented, so a run today must stop before submitting
 * rather than price the form's default dates. If that test ever starts failing
 * because the driver got further, the date control had better be driven *and*
 * verified first.
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
  pickupTime: '12:00',
  dropoffDate: '2026-09-06',
  dropoffTime: '12:00',
};

/** Verbatim from the live site, minus the airport list. */
const SUGGESTION = 'Tampa International Airport TPA Tampa, FL, 33607 US.';

interface FormOptions {
  /** Whether the booking widget has mounted. False models the 503 throttle. */
  hydrated?: boolean;
  /** What the autocomplete offers when typed into. */
  suggestion?: string | null;
  /** What "Browse Vehicles" does. */
  onSubmit?: 'results' | 'rejected' | 'nothing';
  /** Model a controlled input that refuses the value written to it. */
  cidRejectsValue?: boolean;
  /** Earliest month the calendar will show, `[year, monthIndex]`. Aug 2026. */
  firstMonth?: [number, number];
  /** Dates rendered disabled in every grid — the vendor refusing a day. */
  disabledDates?: string[];
  /** Time dropdown options. Defaults to the half-hourly list, bare-hour form. */
  timeOptions?: string[];
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
  const { firstMonth = [2026, 7], disabledDates = [], timeOptions = halfHourly() } = options;

  const earliest = firstMonth[0] * 12 + firstMonth[1];
  let shown = earliest;
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
      header.textContent = `${MONTH_NAMES[month]} ${year}`;
      const forward = document.createElement('button');
      forward.className = 'cta calendar-control-arrow arrow-right';
      forward.setAttribute('aria-label', 'Next Month');
      back.addEventListener('click', () => {
        if (shown > earliest) shown -= 1;
        paintCalendar();
      });
      forward.addEventListener('click', () => {
        shown += 1;
        paintCalendar();
      });
      controls.append(back, header, forward);
      panel.append(controls);

      const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const cells: { id: string; dead: boolean }[] = [];
      for (let d = 1; d <= count; d += 1) {
        cells.push({ id: `${pad(month + 1)}/${pad(d)}/${year}`, dead: false });
      }
      // The spillover: next month's 1st, greyed, in this grid. Only the first
      // panel gets one, exactly as the live calendar renders it.
      if (offset === 0) {
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
          }
          open = null;
          paintToggles();
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
  } = options;

  document.body.innerHTML = '<header>Enterprise Rent-A-Car</header>';
  if (!hydrated) return;

  const form = document.createElement('div');
  form.innerHTML = `
    <label>Pick-up &amp; Return Location</label>
    <div class="location-field"><input name="location-search" placeholder="Provide a Location" /></div>
    <input type="checkbox" id="sameLocation" />
    <div class="location-dropdown__aria-items"></div>
    <select id="age"><option>25+</option></select>
    <label for="cid">Corporate Account Number</label>
    <input type="text" id="cid" />
    <button type="button">Browse Vehicles</button>
  `;
  document.body.append(form);
  renderDateTime(form, options);

  const location = form.querySelector<HTMLInputElement>('input[name="location-search"]')!;
  const menu = form.querySelector<HTMLElement>('.location-dropdown__aria-items')!;
  const chipHost = form.querySelector<HTMLElement>('.location-field')!;

  // The autocomplete: opens on `input`, offers a button, and on selection
  // closes itself and renders the branch as a chip beside the field — which is
  // what the driver verifies against.
  location.addEventListener('input', () => {
    menu.replaceChildren();
    if (!location.value || !suggestion) return;
    const option = document.createElement('button');
    option.textContent = suggestion;
    option.className = 'cta-unstyled';
    option.addEventListener('click', () => {
      menu.replaceChildren();
      const chip = document.createElement('span');
      chip.textContent = suggestion.split(/\bTPA\b/)[0]!.trim();
      chipHost.append(chip);
    });
    menu.append(option);
  });

  if (cidRejectsValue) {
    const cid = form.querySelector<HTMLInputElement>('#cid')!;
    cid.addEventListener('input', () => {
      cid.value = '';
    });
  }

  form.querySelector('button')!.addEventListener('click', () => {
    if (onSubmit === 'results') window.location.hash = '#car_select';
    if (onSubmit === 'rejected') {
      const error = document.createElement('div');
      error.textContent =
        "Error: We're sorry, but this account number cannot be used online. " +
        'Please contact your account manager if you have questions.';
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

  it('fails when the suggestion is only ever in the dropdown', async () => {
    // The check that nearly went in wrong. The menu contains the branch name by
    // construction, so a body-wide search would pass here — with the form
    // holding no selection at all and the next step submitting a blank search.
    renderForm();
    const form = document.querySelector('.location-field')!;
    const context = makeContext();
    const location = document.querySelector<HTMLInputElement>('input[name="location-search"]')!;
    // Selection does nothing: the menu stays open and no chip appears.
    location.addEventListener('input', () => {
      const menu = document.querySelector('.location-dropdown__aria-items')!;
      menu.replaceChildren();
      const option = document.createElement('button');
      option.textContent = SUGGESTION;
      menu.append(option);
    });
    const error = await failureOf(fillLocation(context));
    expect(error.failure).toBe('form-fill');
    expect(form.textContent).not.toContain('Tampa International');
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

describe('drive', () => {
  it('drives the whole form and submits', async () => {
    // This replaces a test asserting the drive *stopped* at the dates, which
    // was correct while `applyDates` refused by design. It now runs end to end.
    renderForm({ onSubmit: 'results' });
    await enterpriseDriver.drive(makeContext());

    expect(window.location.hash).toBe('#car_select');
    expect(document.querySelector<HTMLInputElement>('#cid')?.value).toBe('5666666');
    expect(
      document.querySelector('#pickupCalendarFocusable')?.getAttribute('aria-label'),
    ).toContain('09/04/2026');
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
