import { clock12, isoParts } from '../deeplinks.js';
import {
  DriverError,
  type DriveContext,
  type FormDriver,
  hasToken,
  POLL_MS,
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
 * - A one-way search left in that state reopens the "DIFFERENT RETURN" panel,
 *   which would have this driver — which refuses one-way trips — fill only the
 *   pick-up and price a one-way rental. `clearStaleLocation` collapses it and
 *   verifies the collapse.
 * - Concurrent National tabs in one profile share that state, so two lanes
 *   racing two codes could settle on one. `Vendor.maxLanes` is why they cannot:
 *   National runs one tab at a time however wide the rest of the race is. The
 *   `ACCOUNT NAME` check would not have saved us — both tabs would render the
 *   same name, and nothing here maps a code to the name it should produce.
 *
 * Its submit ends in a real navigation, so `drive` cannot see its own results:
 * the checks live in `verifyResults`, which runs in whichever document holds
 * the results page. See `FormDriver.startPath`.
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
const ACCOUNT_LABEL_RE = /ACCOUNT\s+NAME/i;

/**
 * The longest a *value* rendered beside the label may be.
 *
 * Deliberately a bound on the value rather than on the element holding the
 * header, which is what an earlier version guessed at and could not justify.
 * `I B M CORP (USA)` is sixteen characters; the thing this excludes is a page
 * region that merely happens to follow a stray label.
 */
const ACCOUNT_VALUE_MAX = 60;

/**
 * Did the results page name an account, rather than merely say the words?
 *
 * The label alone is too weak to carry this much weight: "account name" is
 * ordinary sign-in furniture and could sit in a profile menu or a hidden modal
 * on a page showing retail rates, which would pass a retail quote off as a
 * company's. So this asks for a *value* beside the label.
 *
 * Finding the label's own element first is what makes that question answerable.
 * Asked of `document.body`, "is anything after the label" is satisfied by the
 * rest of the page and the check collapses back into matching the label alone.
 * An earlier version bounded the element's text length instead, which worked
 * only if National's header happened to sit inside a small enough element —
 * a number nobody had measured, and every quote would have failed
 * `code-rejected` if it were wrong.
 *
 * So: take the smallest element that still contains the phrase, and accept if
 * the value is inside it (`ACCOUNT NAME I B M CORP (USA)`) or in the element
 * next to it (`<span>ACCOUNT NAME</span><span>I B M CORP (USA)</span>`). Both
 * are ordinary ways to mark up a label and a value, and neither depends on a
 * guess about how the page is nested.
 *
 * Still a heuristic on somebody else's markup, and it fails in the safe
 * direction: a header that stops matching fails the quote loudly rather than
 * letting a retail price through quietly.
 */
export function accountNamed(doc: Document): boolean {
  const holders = [...doc.querySelectorAll<HTMLElement>('*')].filter((el) => {
    if (!ACCOUNT_LABEL_RE.test(textOf(el))) return false;
    // Smallest: no child of it also carries the phrase.
    return ![...el.children].some((child) => ACCOUNT_LABEL_RE.test(textOf(child)));
  });

  for (const holder of holders) {
    const beside = textOf(holder).replace(ACCOUNT_LABEL_RE, ' ').replace(/\s+/g, ' ').trim();
    // Inside the label's own element, no length rule is needed: "the smallest
    // element still carrying the phrase" has already scoped it to a header.
    if (beside) return true;
    // Next to it, one is. A bare label is a sibling of whatever follows it in
    // the document, so without this a sign-in label sitting anywhere on a
    // retail page is "followed by something" and passes — the exact collapse
    // this function exists to avoid, arriving by a different door. A rendered
    // account name is short; a page region is not.
    const sibling = textOf(holder.nextElementSibling);
    if (sibling && sibling.length <= ACCOUNT_VALUE_MAX) return true;
  }
  return false;
}

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
 * Drop locations left over from an earlier search, and leave one-way mode.
 *
 * Not defensive tidying. With a chip present the autocomplete offers nothing at
 * all, so the next step times out — that is how this was found. Silent when
 * there is nothing to clear, which is the ordinary case on a cold profile.
 *
 * Both halves exist because National restores the *whole* previous search. A
 * profile whose last National search was one-way comes back with the "DIFFERENT
 * RETURN" panel open and two location fields, and that is the dangerous shape:
 * this driver refuses one-way trips outright, so filling only the pick-up and
 * submitting would price a one-way rental as the answer to a round-trip
 * question. Every chip is cleared rather than the first, for the same reason.
 *
 * Collapsing the panel is unmeasured — the toggle was never exercised — so it
 * is attempted and then *verified*, and a failure to collapse fails the quote.
 * That is the framework's rule doing its job on a step nobody has watched.
 */
const LOCATION_FIELDS = '[id^="search-autocomplete__input-"]';

export async function clearStaleLocation(ctx: DriveContext): Promise<void> {
  // Bounded rather than `while`, so a chip whose remove button does not remove
  // it is a timeout with a message instead of a spin.
  for (let i = 0; i < 4; i += 1) {
    const remove = ctx.doc.querySelector<HTMLElement>('button.input-pseudo__close-btn');
    if (!remove) break;
    remove.click();
    await waitFor(ctx, 'the stale location chip to clear', () => !remove.isConnected);
  }
  if (ctx.doc.querySelector('button.input-pseudo__close-btn')) {
    throw new DriverError('form-fill', 'could not clear the previous search from the form');
  }

  if (ctx.doc.querySelectorAll(LOCATION_FIELDS).length <= 1) return;
  const toggle = [...ctx.doc.querySelectorAll<HTMLElement>('button')].find((el) =>
    /different return/i.test(textOf(el)),
  );
  if (!toggle) {
    throw new DriverError('form-fill', 'form is in one-way mode with no way back to round trip');
  }
  toggle.click();
  await waitFor(
    ctx,
    'the form to leave the one-way mode a previous search left it in',
    () => ctx.doc.querySelectorAll(LOCATION_FIELDS).length <= 1,
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
  //
  // Deliberately *not* a text search of `.search-autocomplete`, which is what
  // this first shipped as and which was wrong in the way this repo has already
  // been burned by once. The suggestion menu is a BEM element of that same
  // block — `search-autocomplete__results` lives inside it — and every option
  // spells out `Tampa International Airport (TPA)`. So the check passed
  // whenever the dropdown was merely *open*, whether or not the click selected
  // anything, and a National change that moved the click handler would have
  // left the driver submitting whatever location session state had restored.
  // `drivers/enterprise.ts` carries the same exclusion for the same reason.
  await waitFor(ctx, `the form to show the ${iata} branch`, () => {
    const menu = ctx.doc.querySelector('.search-autocomplete__results');
    const leaves = [...ctx.doc.querySelectorAll<HTMLElement>('*')].filter(
      (el) => el.children.length === 0 && textOf(el).includes(`(${iata})`),
    );
    return leaves.some((el) => !menu?.contains(el)) || null;
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

  // Either, not the interstitial only. It is an Emerald Club sign-in prompt, and
  // the probe tabs run in the user's own profile — a signed-in user never sees
  // it. Requiring it meant burning the rest of the budget and reporting
  // `form-submit` on a search that had run perfectly.
  const landed = await waitFor(
    ctx,
    'the guest interstitial or the results page',
    () => {
      if (ctx.doc.location?.hash.includes(RESULTS_HASH)) return 'results' as const;
      const guest = [...ctx.doc.querySelectorAll<HTMLElement>('button, a')].find((el) =>
        /continue as guest/i.test(textOf(el)),
      );
      return guest ?? null;
    },
    'form-submit',
  );

  // Clicking through is declining to authenticate, not authenticating. It also
  // navigates, so this document may not survive the click — which is exactly
  // why the results checks live in `verifyResults` rather than here.
  if (landed !== 'results') landed.click();
}

/**
 * How long to keep looking for the account header once results are on screen.
 *
 * Bounded separately from the drive so that "no account" is a finding rather
 * than a stopwatch. The first version reported a plain `waitFor` timeout as
 * `code-rejected`, so a results page that painted its header a moment late told
 * the user their employer's code had been refused — a confident, specific,
 * wrong claim about the thing the tool exists to answer.
 */
const ACCOUNT_GRACE_MS = 4_000;

export async function verifyResults(ctx: DriveContext): Promise<void> {
  // First that a search happened at all. On this path the document may be a
  // fresh one that never drove anything, having been re-injected after
  // National's own navigation.
  await waitFor(
    ctx,
    'National to answer the search',
    () => ctx.doc.location?.hash.includes(RESULTS_HASH) || null,
    'form-submit',
  );

  // Then that the discount applied. Absence here is not a missing price — it is
  // the retail rate, which is exactly what the control run returned, and
  // reporting it as a company's rate is the failure this codebase refuses.
  const graceEnds = Math.min(ctx.deadline, ctx.now() + ACCOUNT_GRACE_MS);
  for (;;) {
    if (accountNamed(ctx.doc)) return;
    if (ctx.now() >= graceEnds) {
      throw new DriverError(
        'code-rejected',
        'results came back with no corporate account applied, so these are retail rates',
      );
    }
    await ctx.sleep(POLL_MS);
  }
}

export const nationalDriver: FormDriver = {
  startUrl: () => START_URL,
  startPath: new URL(START_URL).pathname,
  async drive(ctx) {
    await waitFor(ctx, "National's booking widget to hydrate", () =>
      ctx.doc.querySelector('#search-autocomplete__input-PICKUP'),
    );
    await fillLocation(ctx);
    await applyDates(ctx);
    await fillAccountNumber(ctx);
    await submitSearch(ctx);
  },
  verifyResults,
};
