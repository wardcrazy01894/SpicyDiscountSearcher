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
  awaitHydration,
  enterpriseDriver,
  fillAccountNumber,
  fillLocation,
  submitSearch,
} from '../src/core/drivers/enterprise.js';
import { FORM_DRIVERS } from '../src/core/drivers/index.js';
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
  it('is deliberately not registered, so no run can reach it', () => {
    // The gate. `applyDates` is unimplemented, so wiring this into
    // `FORM_DRIVERS` would let a run reach a driver that cannot set the trip's
    // dates. Registering it is part of the change that finishes it.
    //
    // Asserted against the registry that National now lives in, so this is
    // "Enterprise specifically is absent" rather than "nothing is registered" —
    // the latter stopped being the point the moment a driver shipped.
    expect(FORM_DRIVERS.enterprise).toBeUndefined();
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

describe('applyDates', () => {
  it('always refuses, because the date control is not driven yet', async () => {
    // This is the whole reason Enterprise is still unsearchable. It is a pin on
    // an admission, not on behaviour we want to keep: when the control is
    // measured and driven, this test is replaced by ones that set a date and
    // read it back.
    renderForm();
    const error = await failureOf(applyDates(makeContext()));
    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/not driven yet/);
    // Names the dates it declined to set, so the popup's tooltip says what was
    // asked for rather than only that something was refused.
    expect(error.message).toContain('2026-09-04');
    expect(error.message).toContain('2026-09-06');
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
  it('stops at the dates, before anything is submitted', async () => {
    renderForm({ onSubmit: 'results' });
    const error = await failureOf(enterpriseDriver.drive(makeContext()));

    expect(error.failure).toBe('form-fill');
    expect(error.message).toMatch(/not driven yet/);
    // The half that matters: a form that cannot express the trip is never sent.
    // Ordering `applyDates` before the submit is what guarantees it.
    expect(window.location.hash).toBe('');
  });

  it('opens the reservation page, which carries no itinerary', () => {
    // A driver's URL is not a deep link — nothing about the search is in it,
    // which is exactly why Enterprise needs driving.
    expect(enterpriseDriver.startUrl()).toBe('https://www.enterprise.com/en/reserve.html');
    expect(enterpriseDriver.startUrl()).not.toContain('?');
  });
});
