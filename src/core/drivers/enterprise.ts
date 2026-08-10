import { airportCode } from '../deeplinks.js';
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
 * Enterprise's search form, driven.
 *
 * Enterprise keeps its itinerary in session state, so `deeplinks.ts` refuses to
 * build a URL for it and always will. Driving the form is the only route to a
 * price, and — contrary to what this repo said until 2026-08-08 — the form is a
 * good shape for it.
 *
 * **Measured against the live site**, `https://www.enterprise.com/en/reserve.html`
 * is a *single* visible step, not the multi-step wizard the old notes described:
 *
 * - `input[name="location-search"]` — pick-up, an autocomplete. `#sameLocation`
 *   reveals a second one for a one-way drop-off.
 * - two date controls and two time `select`s, plus `#age`
 * - `#cid` — a plain visible text input labelled "Corporate Account Number".
 *   The `XZ…` codes go here, on step one.
 * - a submit button reading "Browse Vehicles"
 *
 * A run driven exactly this way reached `/en/reserve.html#car_select` with 71
 * vehicle classes priced $46–$341 for a Tampa round trip.
 *
 * Two findings that shape the code below:
 *
 * - **The results page names the account holder.** IBM's `5666666` rendered
 *   `I B M CORP (USA)` in the header. That is a per-code check of a kind no
 *   other vendor here offers — it can prove the discount *applied* rather than
 *   being silently dropped. Deliberately not implemented yet: it needs a
 *   trustworthy company-name-to-rendered-name comparison, and `Accenture` vs
 *   `I B M CORP (USA)` is exactly the fuzzy match that produces false failures
 *   and throws away good quotes. See the note in `submitSearch`.
 * - **Enterprise refuses some account numbers outright.** Accenture's
 *   `XZ15J55` came back with "this account number cannot be used online.
 *   Please contact your account manager." That is the vendor answering, not the
 *   driver breaking, and it gets its own code so the popup can say so.
 *
 * ## Why this is not registered in `FORM_DRIVERS` yet
 *
 * `applyDates` is not implemented, because the date control was never
 * exercised — both live runs used the form's own defaults. Everything else here
 * is measured, but a driver that silently accepted default dates would race a
 * code against a trip the user did not ask for and report the price as theirs,
 * which is the precise failure this codebase is organised around refusing.
 *
 * So the driver exists, is tested, and **always fails at the date step today**.
 * Finishing it is one function plus the verification described on it.
 */

/** Where the form lives. Carries no itinerary — that is the whole point. */
const START_URL = 'https://www.enterprise.com/en/reserve.html';

/** The vendor's own words when it will not accept an account number.
 *
 * Matched on the distinctive middle of the sentence rather than the whole
 * thing, so a reworded apology around it still classifies. Verbatim as seen:
 * "We're sorry, but this account number cannot be used online. Please contact
 * your account manager if you have questions." */
const REJECTED_RE = /cannot be used online/i;

/** The hash Enterprise puts on the URL once a search has produced results. */
const RESULTS_HASH = 'car_select';

function carTrip(ctx: DriveContext): CarTrip {
  if (ctx.trip.category !== 'car') {
    throw new DriverError('form-fill', 'enterprise is a car vendor, got a hotel trip');
  }
  return ctx.trip;
}

/**
 * Wait for the booking widget to mount.
 *
 * Not a formality. The probe runs at `document_idle`, and Enterprise's widget
 * is nowhere near ready then: `#cid` appeared about ten seconds after load on
 * one run and about forty on another, and on a third it never appeared at all —
 * document 200, nav and footer rendered, booking app absent, a 503 in the
 * request log. That last one is Enterprise throttling a profile that has been
 * hit hard, the same way Avis does, and it is the single likeliest way this
 * driver fails in the wild.
 *
 * It therefore gets its own message rather than sharing "could not fill the
 * search form", because the two want opposite responses: one means the markup
 * moved, the other means back off and try later.
 *
 * **This is also the timing problem that has to be solved before Enterprise
 * becomes searchable.** Forty seconds of hydration against a
 * `PROBE_TIMEOUT_MS` of 45s leaves nothing for filling, submitting, or pricing.
 * Raising that constant is not free — `KEEPALIVE_CEILING_MS` is derived from it
 * — so it is a deliberate change to make with the flag, not a number to nudge.
 */
export async function awaitHydration(ctx: DriveContext): Promise<HTMLInputElement> {
  return waitFor(ctx, "Enterprise's booking widget to hydrate (it may be throttling us)", () =>
    ctx.doc.querySelector<HTMLInputElement>('#cid'),
  );
}

/**
 * Type the airport and take the autocomplete's own suggestion.
 *
 * Typing alone is not enough: the field is an autocomplete, and submitting with
 * raw text in it does not select a branch. The measured flow is type, wait for
 * the dropdown, click the option.
 *
 * Then it checks. The form renders the chosen branch as a chip reading "Tampa
 * International Airport", so after clicking we confirm that name is on the
 * page — the difference between "we clicked something" and "the form now holds
 * the location we wanted". Enterprise is a session-state site, so the field can
 * arrive already carrying somebody's previous search, and an unverified fill
 * would silently price it.
 */
export async function fillLocation(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);

  // One-way is refused rather than guessed at, the same call `sameCityOnly`
  // makes for Avis and Hertz. `#sameLocation` exists and reveals a second
  // input, but neither driving it nor verifying the result has been measured,
  // and a one-way rental prices nothing like the round trip the user asked for.
  const dropoff = trip.dropoffLocation.trim();
  if (dropoff && dropoff.toUpperCase() !== trip.pickupLocation.trim().toUpperCase()) {
    throw new DriverError(
      'form-fill',
      'enterprise one-way trips are not supported: its drop-off field is undriven',
    );
  }

  let iata: string;
  try {
    iata = airportCode(trip.pickupLocation);
  } catch (error) {
    throw new DriverError('form-fill', error instanceof Error ? error.message : String(error));
  }

  const fields = ctx.doc.querySelectorAll<HTMLInputElement>('input[name="location-search"]');
  const pickup = fields[0];
  if (!pickup) throw new DriverError('form-fill', 'no location field on the reservation form');

  setNativeValue(pickup, iata);

  // The dropdown lives in a `location-dropdown__*` container and its options are
  // buttons. Scoped to that container on purpose: a document-wide button search
  // for the airport code also matches nav and footer links on a page that
  // happens to mention the city.
  const option = await waitFor(ctx, `the autocomplete to offer ${iata}`, () => {
    const menu = ctx.doc.querySelector('[class*="location-dropdown"]');
    if (!menu) return null;
    const buttons = [...menu.querySelectorAll<HTMLElement>('button, [role="option"], li')];
    return buttons.find((el) => hasToken(textOf(el), iata)) ?? null;
  });

  // The branch name is everything before the airport code — "Tampa
  // International Airport TPA Tampa, FL, 33607 US." yields "Tampa
  // International Airport", which is what the chip renders.
  const optionText = textOf(option);
  const name = optionText.split(new RegExp(`\\b${iata}\\b`, 'i'))[0]?.trim() ?? '';

  option.click();

  // Falls back to the code when the option carried no name before it, rather
  // than checking against an empty string — which would succeed on every page,
  // including a blank one.
  const expected = name || iata;

  await waitFor(ctx, `the form to show the ${iata} branch it was given`, () => {
    // Deliberately *not* a search of the whole page. The suggestion menu
    // contains this exact name — it is where the name came from — so a body-wide
    // `includes` passes whether or not the click did anything, which is the
    // difference between verifying a selection and verifying that a dropdown
    // once opened. The proof is the name rendered somewhere the menu is not:
    // the form shows the chosen branch as a chip beside the field.
    const menu = ctx.doc.querySelector('[class*="location-dropdown"]');
    const leaves = [...ctx.doc.body.querySelectorAll<HTMLElement>('*')].filter(
      (el) => el.children.length === 0 && textOf(el).includes(expected),
    );
    return leaves.some((el) => !menu?.contains(el)) || null;
  });
}

/**
 * Set the trip's dates, and confirm the form took them.
 *
 * **Not implemented, and the reason Enterprise is still `searchable: false`.**
 *
 * Both live runs used the form's default dates — tomorrow to the day after —
 * because the date control is a custom widget rather than a `select` and
 * driving it was never measured. Filling everything else and letting this pass
 * silently would submit a search for dates the user never asked for and return
 * its price as the answer: a real page, a real number, the wrong rental. That
 * is the exact shape `verify-trip.ts` exists to catch for Avis and the exact
 * trade `deeplinks.ts` makes when it throws on a malformed date.
 *
 * To finish it, on a browser Enterprise is not throttling:
 *
 * 1. Dump the control's DOM — it sits between the location field and `#age`,
 *    rendering as `09 Aug 2026` with a chevron. Find out whether it is backed
 *    by a real `input`, a set of `select`s, or a calendar popover only.
 * 2. Drive it, whichever it turns out to be.
 * 3. **Read the rendered dates back and compare them against the trip**, and
 *    throw `form-fill` here when they disagree. That readback is not optional
 *    polish; it is what makes the step trustworthy, and it is cheap because the
 *    form prints the dates in its own summary.
 *
 * The two time `select`s alongside it are ordinary `<select>` elements and
 * should fall to `setNativeValue`, but they are unverified too and belong in
 * the same measurement.
 */
export function applyDates(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);
  return Promise.reject(
    new DriverError(
      'form-fill',
      `enterprise date control is not driven yet, so ${trip.pickupDate}..${trip.dropoffDate} ` +
        'cannot be set — refusing rather than pricing the form default',
    ),
  );
}

/** Put the code in the Corporate Account Number field, and confirm it stuck. */
export async function fillAccountNumber(ctx: DriveContext): Promise<void> {
  const cid = ctx.doc.querySelector<HTMLInputElement>('#cid');
  if (!cid) throw new DriverError('form-fill', 'no Corporate Account Number field on the form');
  setNativeValue(cid, ctx.code);
  // Read back rather than trust the write, and *wait* for the read-back rather
  // than taking it immediately. A controlled input that rejected the value looks
  // identical from here otherwise, and submitting without a code prices the
  // retail rate and reports it as the company's. The wait is not padding: a
  // framework-backed field re-renders on its own schedule, so checking on the
  // same tick tests our assignment rather than the page's acceptance of it.
  await waitFor(ctx, 'the account number field to keep the code', () => cid.value === ctx.code);
}

/**
 * Submit, and decide what the answer was.
 *
 * Three outcomes, and they are genuinely different things:
 * - the results hash appears — the search ran
 * - the vendor says the account number cannot be used online — it answered, and
 *   this code is unusable at Enterprise however the driver behaves
 * - neither, before the deadline — the search never ran
 *
 * Not implemented here, and worth writing down because it is the most valuable
 * check available at this vendor: the results page names the account holder
 * (`I B M CORP (USA)` for IBM's code), so it can prove the discount applied
 * rather than being silently dropped. It needs a comparison between the
 * workbook's company name and the vendor's rendering of it, and those differ
 * enough — spacing, `CORP`, `(USA)` — that a naive match would fail good quotes
 * for most companies. Worth doing properly, as a peer of `verify-trip.ts`, once
 * there are enough real examples to know what the rendering looks like.
 */
export async function submitSearch(ctx: DriveContext): Promise<void> {
  const button = [...ctx.doc.querySelectorAll<HTMLElement>('button, input[type="submit"]')].find(
    (el) => /browse vehicles/i.test(textOf(el) || (el as HTMLInputElement).value || ''),
  );
  if (!button) throw new DriverError('form-fill', 'no "Browse Vehicles" button on the form');

  button.click();

  await waitFor(
    ctx,
    'Enterprise to answer the search',
    () => {
      if (REJECTED_RE.test(textOf(ctx.doc.body))) {
        throw new DriverError(
          'code-rejected',
          'Enterprise says this account number cannot be used online',
        );
      }
      return ctx.doc.location?.hash.includes(RESULTS_HASH) || null;
    },
    'form-submit',
  );
}

/**
 * Confirm a search actually ran, without re-running one.
 *
 * Enterprise submits in place — its results are a `#car_select` fragment on the
 * same document — so unlike National there is no navigation to survive and
 * `submitSearch` already sees its own outcome. This exists so the contract is
 * one shape for every driver, and it deliberately does **not** reuse
 * `submitSearch`: that clicks the button, and a verification step that submits
 * the form again is a second search per quote.
 *
 * No account check here. Enterprise's results page names the account holder too
 * (`I B M CORP (USA)` for IBM's code), which is the check worth adding when
 * this driver becomes reachable — see the note in `submitSearch`.
 */
export async function verifyResults(ctx: DriveContext): Promise<void> {
  await waitFor(
    ctx,
    'Enterprise to be showing a results page',
    () => ctx.doc.location?.hash.includes(RESULTS_HASH) || null,
    'form-submit',
  );
}

export const enterpriseDriver: FormDriver = {
  startUrl: () => START_URL,
  startPath: new URL(START_URL).pathname,
  verifyResults,
  async drive(ctx) {
    await awaitHydration(ctx);
    await fillLocation(ctx);
    // Always throws today. Deliberately placed before the code and the submit:
    // there is no point typing a discount code into a form that is about to be
    // submitted for the wrong dates, and stopping here means a half-driven form
    // is never sent.
    await applyDates(ctx);
    await fillAccountNumber(ctx);
    await submitSearch(ctx);
  },
};
