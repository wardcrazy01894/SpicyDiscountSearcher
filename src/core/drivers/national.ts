import { clock12, isoParts } from '../deeplinks.js';
import {
  DriverError,
  type DriveContext,
  type FormDriver,
  hasToken,
  setNativeValue,
  textOf,
  waitFor,
} from '../form-driver.js';
import type { CarTrip } from '../types.js';

/**
 * National's search form, driven — and the first one proved end to end.
 *
 * Measured against the live site on 2026-08-10, with a controlled differential
 * rather than a single hopeful run. Same trip (TPA, Sep 4–6), same session,
 * minutes apart:
 *
 * | | with `5666666` | control |
 * | --- | --- | --- |
 * | `ACCOUNT NAME` | `I B M CORP (USA)` | absent |
 * | rate label | "Custom Rate" | absent |
 * | Compact SUV | $70.30/day, $185.05 | $74.00/day, $193.80 |
 * | results | 34 | 34 |
 *
 * Same vehicle, same result count, different price. That is the pair of facts
 * that rules out "the form submitted and the code did nothing" — the same
 * standard `deeplinks.ts` holds Hertz to, and the reason this file exists while
 * `enterprise.ts` still refuses to run.
 *
 * The form is on `/en/home.html`, not a `/reserve` route, and is a different
 * shape from Enterprise's despite the two sharing a backend (National's own
 * location lookup goes to `prd.location.enterprise.com`). Nothing ports; the
 * selectors below are National's.
 *
 * What this driver does *not* claim, stated rather than discovered later:
 * `#age-selector` is left at the form's own default of 25+, because the popup
 * collects no driver age. That matches the hard-coded `age=25` in Avis's and
 * Hertz's deep links and carries the same cost — it dodges the under-25
 * surcharge, so the price can understate what a younger renter would pay. The
 * trip was proved on a US airport round trip only; nothing here has been
 * exercised outside the US.
 *
 * ## The thing that makes this vendor dangerous
 *
 * **National carries the previous search in session state — location, dates and
 * the account number.** Reloading the form after a search showed the chip, both
 * dates, and `#contract__input` still holding `5666666`, with the toggle
 * reading `Account Number (I B M CORP (USA)) / Coupons`.
 *
 * That is the Avis `booking-widget.store` problem at another vendor, and here it
 * is *observed* rather than suspected. Two consequences, both handled:
 *
 * - A stale location chip suppresses the autocomplete entirely — typing into a
 *   field that already holds a selection offers no suggestions, which is a
 *   measured failure and not a theory. `clearStaleLocation` removes it first.
 * - Concurrent National tabs in one profile share that state, so two lanes
 *   racing two codes can settle on one. **This is why National is not
 *   registered in `FORM_DRIVERS` yet**: it needs a per-vendor concurrency of
 *   one, which the worker cannot express today. The `ACCOUNT NAME` check below
 *   does not save us — both tabs would render the same name, and nothing here
 *   maps a code to the name it should produce.
 */

const START_URL = 'https://www.nationalcar.com/en/home.html';

/** The results hash. National writes `#/car_select`; Enterprise `#car_select`. */
const RESULTS_HASH = 'car_select';

/**
 * The results page's own statement that a corporate account was applied.
 *
 * Measured in both directions, which is what makes it usable as a gate: present
 * as `ACCOUNT NAME I B M CORP (USA)` with a code, and entirely absent on the
 * control run. A search that reaches results without it priced the retail rate,
 * and reporting that as a company's discounted rate is the failure this whole
 * codebase is built to refuse.
 */
const ACCOUNT_NAME_RE = /ACCOUNT\s+NAME/i;

const MONTHS = [
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

function carTrip(ctx: DriveContext): CarTrip {
  if (ctx.trip.category !== 'car') {
    throw new DriverError('form-fill', 'national is a car vendor, got a hotel trip');
  }
  return ctx.trip;
}

/**
 * The calendar's own way of naming a day, from an ISO date.
 *
 * Built from `isoParts` rather than `new Date(iso)`, which parses a bare
 * `yyyy-mm-dd` as UTC and lands on the previous day for anyone west of
 * Greenwich — a whole day wrong, silently, for exactly the users this is aimed
 * at. `popup.ts` avoids `toISOString` for the same reason.
 */
export function calendarLabels(iso: string): { month: string; day: string } {
  const { year, month, day } = isoParts(iso);
  const name = MONTHS[Number(month) - 1];
  if (!name) throw new DriverError('form-fill', `not a month: ${month}`);
  // The day carries no leading zero in the aria-label — "September 4".
  return { month: `${name} ${year}`, day: `${name} ${String(Number(day))}` };
}

/**
 * National's time `select` values: a half-hour index from midnight.
 *
 * Measured — option 24 is "12:00 PM", 23 is "11:30 AM". Routed through
 * `clock12` purely as the validator, so a malformed time fails here rather than
 * silently becoming index 0 and searching for midnight.
 */
export function timeIndex(hhmm: string): string {
  const { hour24, minute } = clock12(hhmm);
  return String(Number(hour24) * 2 + (Number(minute) >= 30 ? 1 : 0));
}

/**
 * Drop a location left over from an earlier search.
 *
 * Not defensive tidying. With a chip present the autocomplete offers nothing at
 * all, so the next step times out — that is how this was found. Silent when
 * there is nothing to clear, which is the ordinary case on a cold profile.
 */
export async function clearStaleLocation(ctx: DriveContext): Promise<void> {
  const remove = ctx.doc.querySelector<HTMLElement>('button.input-pseudo__close-btn');
  if (!remove) return;
  remove.click();
  await waitFor(
    ctx,
    'the stale location chip to clear',
    () => !ctx.doc.querySelector('button.input-pseudo__close-btn'),
  );
}

export async function fillLocation(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);

  // Refused rather than guessed at, as with Avis, Hertz and Enterprise. National
  // has a "DIFFERENT RETURN" toggle that reveals a second field; driving and
  // verifying it has not been measured, and a one-way rental prices nothing like
  // the round trip the user asked for.
  const dropoff = trip.dropoffLocation.trim();
  if (dropoff && dropoff.toUpperCase() !== trip.pickupLocation.trim().toUpperCase()) {
    throw new DriverError(
      'form-fill',
      'national one-way trips are not supported: its return field is undriven',
    );
  }

  const iata = trip.pickupLocation.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) {
    throw new DriverError('form-fill', `expected a 3-letter airport code, got: ${iata}`);
  }

  await clearStaleLocation(ctx);

  const field = ctx.doc.querySelector<HTMLInputElement>('#search-autocomplete__input-PICKUP');
  if (!field) throw new DriverError('form-fill', 'no location field on the reservation form');
  field.focus();
  setNativeValue(field, iata);

  // Only `button.search-autocomplete__result` is clickable. The `<li>` wrapping
  // it renders the same text and swallows a click silently, which cost a whole
  // debugging pass — the menu closed, nothing was selected, and the next step
  // looked like the site had changed.
  const option = await waitFor(ctx, `the autocomplete to offer ${iata}`, () => {
    const results = [
      ...ctx.doc.querySelectorAll<HTMLElement>('button.search-autocomplete__result'),
    ];
    return results.find((el) => hasToken(textOf(el), iata)) ?? null;
  });
  option.click();

  // The widget renders the branch as `Tampa International Airport (TPA)`, so the
  // parenthesised code is the readback — and unlike Enterprise's chip it carries
  // the code itself, which is what we actually asked for rather than a name we
  // inferred.
  await waitFor(ctx, `the form to show the ${iata} branch`, () => {
    const widget = ctx.doc.querySelector('.search-autocomplete');
    return textOf(widget).includes(`(${iata})`) || null;
  });
}

/**
 * Set one date through the calendar, and confirm the field took it.
 *
 * The control is a `<button role="combobox">` with no input behind it, so
 * clicking a day cell is the only route. Day buttons carry
 * `aria-label="September 4"` and sit inside a wrapper labelled
 * `Calendar - September 2026`; past days are `disabled`, which is reported as
 * such rather than as a missing cell because the two want different fixes.
 *
 * The readback is the toggle's own text becoming `Sep 4`. That is the step that
 * makes this trustworthy, and the one Enterprise's driver is still missing.
 */
export async function setDate(
  ctx: DriveContext,
  toggleId: string,
  iso: string,
  which: string,
): Promise<void> {
  const { month, day } = calendarLabels(iso);
  const toggle = ctx.doc.querySelector<HTMLElement>(`#${toggleId}`);
  if (!toggle) throw new DriverError('form-fill', `no ${which} date control on the form`);
  toggle.click();

  const cell = await waitFor(ctx, `the calendar to offer ${day} ${month}`, () => {
    const wrappers = [...ctx.doc.querySelectorAll<HTMLElement>('.date-selector__month-wrapper')];
    const wrapper = wrappers.find(
      (el) =>
        (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim() === `Calendar - ${month}`,
    );
    if (!wrapper) return null;
    return wrapper.querySelector<HTMLButtonElement>(
      `button.date-selector__day[aria-label="${day}"]`,
    );
  });

  if (cell.disabled) {
    throw new DriverError('form-fill', `national will not accept ${which} date ${iso}`);
  }
  cell.click();

  // `Sep 4` for `September 4`. Compared on the abbreviation and the number so a
  // change to the toggle's formatting fails loudly here rather than letting a
  // default date through.
  const expected = `${day.slice(0, 3)} ${day.split(' ')[1] ?? ''}`.trim();
  await waitFor(
    ctx,
    `the ${which} field to read ${expected}`,
    () => textOf(toggle).toLowerCase() === expected.toLowerCase() || null,
  );
}

export async function applyDates(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);
  await setDate(ctx, 'date-time__pickup-toggle', trip.pickupDate, 'pick-up');
  // The return calendar opens on the pick-up's month rather than today's, so
  // this must run after the pick-up is set or the wrapper it looks for may not
  // be rendered.
  await setDate(ctx, 'date-time__return-toggle', trip.dropoffDate, 'return');

  for (const [id, time] of [
    ['PICKUP', trip.pickupTime],
    ['RETURN', trip.dropoffTime],
  ] as const) {
    const select = ctx.doc.querySelector<HTMLSelectElement>(`#${id}`);
    if (!select) throw new DriverError('form-fill', `no ${id} time control on the form`);
    const wanted = timeIndex(time);
    setNativeValue(select, wanted);
    if (select.value !== wanted) {
      throw new DriverError('form-fill', `national did not accept the ${id} time ${time}`);
    }
  }
}

/** Reveal the account panel and type the code in. */
export async function fillAccountNumber(ctx: DriveContext): Promise<void> {
  const toggle = [...ctx.doc.querySelectorAll<HTMLElement>('button')].find((el) =>
    /account number/i.test(textOf(el)),
  );
  if (!toggle) throw new DriverError('form-fill', 'no account-number panel on the form');

  // The panel is collapsed by default and the field is absent until it opens,
  // so this is a step rather than a convenience.
  if (!ctx.doc.querySelector('#contract__input')) toggle.click();

  const field = await waitFor(ctx, 'the account number field', () =>
    ctx.doc.querySelector<HTMLInputElement>('#contract__input'),
  );

  // Written unconditionally, never appended to. Session state can leave another
  // code in here, and that is the contamination this vendor is prone to.
  field.focus();
  setNativeValue(field, ctx.code);
  await waitFor(ctx, 'the account number field to keep the code', () => field.value === ctx.code);
}

/**
 * Submit, clear the guest interstitial, and confirm the discount applied.
 *
 * The interstitial is not a one-off: "Sign in or Continue as a Guest" appeared
 * on both measured searches, so it is per-search rather than per-session.
 * Clicking through it is declining to authenticate, not authenticating.
 *
 * The last check is the one that matters. A search can reach a real results page
 * with real prices and no account applied — that is precisely the control run
 * above — and those prices are the retail rate. Reporting them as a company's
 * discounted rate would be the silent wrong answer, so their absence is
 * `code-rejected` rather than a quiet success.
 */
export async function submitSearch(ctx: DriveContext): Promise<void> {
  const button = [...ctx.doc.querySelectorAll<HTMLElement>('button')].find((el) =>
    /check availability/i.test(textOf(el)),
  );
  if (!button) throw new DriverError('form-fill', 'no "Check Availability" button on the form');
  button.click();

  const guest = await waitFor(
    ctx,
    'the sign-in or guest interstitial',
    () =>
      [...ctx.doc.querySelectorAll<HTMLElement>('button, a')].find((el) =>
        /continue as guest/i.test(textOf(el)),
      ) ?? null,
    'form-submit',
  );
  guest.click();

  await waitFor(
    ctx,
    'National to answer the search',
    () => ctx.doc.location?.hash.includes(RESULTS_HASH) || null,
    'form-submit',
  );

  await waitFor(
    ctx,
    'the results page to name the account the code belongs to',
    () => ACCOUNT_NAME_RE.test(textOf(ctx.doc.body)) || null,
    'code-rejected',
  );
}

export const nationalDriver: FormDriver = {
  startUrl: () => START_URL,
  async drive(ctx) {
    await waitFor(ctx, "National's booking widget to hydrate", () =>
      ctx.doc.querySelector('#search-autocomplete__input-PICKUP'),
    );
    await fillLocation(ctx);
    await applyDates(ctx);
    await fillAccountNumber(ctx);
    await submitSearch(ctx);
  },
};
