import { airportCode, clock12, isoParts } from '../deeplinks.js';
import {
  type DriveEvidence,
  DriverError,
  type DriveContext,
  type FormDriver,
  nudgeInput,
  POLL_MS,
  setNativeValue,
  textOf,
  textOutside,
  visibleText,
  waitFor,
  waitForSettled,
  waitWithRetry,
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
 *   `I B M CORP (USA)` in the header. That can prove the discount *applied*
 *   rather than being silently dropped, which is the one failure this driver
 *   cannot otherwise see: a code Enterprise ignores rather than refuses gives a
 *   real results page at the retail rate, reported as the company's.
 *
 *   **Implemented in `verifyResults`, since 2026-10-26.** The markup was the
 *   only thing missing — this comment used to say so, and the capture turned
 *   out to be exactly the ten lines it predicted. With IBM's code the header
 *   carries `button.contract-name__button` with the holder's name in its
 *   `aria-label`, inside `#codebanner-container`; the same search with *no*
 *   code renders that container empty, and the cards lose their "Custom Rate"
 *   tag. So the button is the vendor saying a contract applied, and its
 *   absence on a results page is `discount-missing` — our inference, never
 *   remembered, as `rejected-codes.ts` requires.
 * - **Enterprise refuses some account numbers outright.** Accenture's
 *   `XZ15J55` came back with "this account number cannot be used online.
 *   Please contact your account manager." That is the vendor answering, not the
 *   driver breaking, and it gets its own code so the popup can say so.
 *
 * ## What is measured, and what is not
 *
 * Registered, `searchable: true`, and live since 2026-08-12. Every step below
 * is filled *and verified against what the form renders back*, which is the
 * framework's one rule.
 *
 * Nothing below is inference any more. The two things that were — the time
 * dropdowns' option format and the results page's account-holder markup —
 * were both measured on 2026-10-26, and the measurements are recorded where
 * they sit (`timeOption`, `CONTRACT_NAME`). The same day the whole driver was
 * run from a loaded build, in the extension's own probe tab — raised on
 * screen by the paint hold for the drive, as `needsPaintedWindow` requires,
 * and minimised again before `verifyResults` ran — and returned a priced
 * results page in about ten seconds. Once more with the browser's own window
 * maximised, since the hold raises the probe window *unfocused* and a window
 * fully behind a maximised one might be occluded rather than painted: it
 * priced the same. The three
 * outcomes `submitSearch` distinguishes were each produced live too: IBM's
 * `5666666` priced, an empty code priced with no account named, and
 * Accenture's `XZ15J55` refused with the sentence `REJECTED_RE` matches.
 *
 * The timing problem this section used to list first is solved by
 * `probeTimeoutMs: 120_000` in `vendors.ts`, since the widget can take ~40s to
 * mount against a 45s default.
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

/**
 * Enterprise's other answers, all measured racing every code on 2026-10-27
 * and all costing a 70s `form-submit` timeout until they were read:
 *
 * - "We're sorry, but the promotion code provided for this reservation is
 *   invalid. Please update or remove to continue." — JP Morgan's `XZ240G`.
 *   The vendor's verdict on the code, so `code-rejected`.
 * - "Please sign in to your Enterprise Plus® account to continue." — EY's
 *   `XZ24S06`. The code is real but usable only behind a login this
 *   extension does not have. `discount-missing`, not `code-rejected`: a
 *   refusal is remembered for good, and this one is about the session.
 * - "We're sorry, but no vehicles are available at this time. Please call us
 *   for assistance." — Purdue's `XZ78806`, which National priced the same
 *   minute. The search ran and was answered with nothing: `probe-empty`, not
 *   a refusal of the code, and not remembered.
 */
const INVALID_RE = /promotion code[^.]*is invalid/i;
const SIGN_IN_RE = /please sign in to your enterprise plus/i;
const NO_VEHICLES_RE = /no vehicles are available/i;

/** Throw if the form page is showing one of the vendor's answers to the search. */
function refuseIfAnswered(text: string): void {
  if (REJECTED_RE.test(text)) {
    throw new DriverError(
      'code-rejected',
      'Enterprise says this account number cannot be used online',
    );
  }
  if (INVALID_RE.test(text)) {
    throw new DriverError(
      'code-rejected',
      'Enterprise says the promotion code provided for this reservation is invalid',
    );
  }
  if (SIGN_IN_RE.test(text)) {
    // Not `code-rejected`, though it reads like one: that code is remembered
    // for good, and this is the vendor's verdict on the *session*, not the
    // code. A user who signs in to Enterprise Plus in their profile would
    // have the code price on the next run, and must not have to find the
    // "try them again" control first. `discount-missing` is the nearest
    // honest code — the search was asked and no discount was applied — and
    // it is not remembered.
    throw new DriverError(
      'discount-missing',
      'Enterprise says this account needs an Enterprise Plus sign-in, which the extension cannot do',
    );
  }
  if (NO_VEHICLES_RE.test(text)) {
    throw new DriverError(
      'probe-empty',
      'Enterprise says no vehicles are available at this time under this account',
    );
  }
}

/** The hash Enterprise puts on the URL once a search has produced results. */
const RESULTS_HASH = 'car_select';

/**
 * Where this tab records that *it* submitted a search, and for which code.
 *
 * `sessionStorage` is per tab and survives a reload of the document, which is
 * exactly the pair of properties needed: a reload of the results view finds
 * the marker and knows the search on screen is its own, while a fresh tab —
 * or a results view Enterprise restored from its own session state — finds
 * none and drives the form from the top. The code is the value so a tab that
 * raced code A and is now assigned code B cannot mistake A's results for B's.
 */
const SUBMITTED_KEY = 'spicy-discount-searcher:enterprise:submitted';

function markSubmitted(ctx: DriveContext): void {
  try {
    ctx.doc.defaultView?.sessionStorage.setItem(SUBMITTED_KEY, ctx.code);
  } catch {
    // Storage can be unavailable (a sandboxed document); the driver then just
    // cannot recognise its own reload, which fails loudly rather than wrongly.
  }
}

function submittedHere(ctx: DriveContext): boolean {
  try {
    return ctx.doc.defaultView?.sessionStorage.getItem(SUBMITTED_KEY) === ctx.code;
  } catch {
    return false;
  }
}

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
 * **This is why Enterprise carries its own probe budget.** Forty seconds of
 * hydration against the 45s default leaves nothing for filling, submitting or
 * pricing, so `vendors.ts` gives it `probeTimeoutMs: 120_000`. Per-vendor
 * rather than a raised default, because the default also bounds how long a tab
 * sits open on every *other* vendor's site.
 */
export async function awaitHydration(ctx: DriveContext): Promise<HTMLInputElement> {
  return waitFor(ctx, "Enterprise's booking widget to hydrate (it may be throttling us)", () =>
    ctx.doc.querySelector<HTMLInputElement>('#cid'),
  );
}

/**
 * The **visible** suggestion list.
 *
 * Deliberately not `[class*="location-dropdown"]`, which is what this shipped as
 * and which was wrong on every run. Enterprise renders the suggestions *twice*,
 * measured on the live form 2026-08-12:
 *
 * | element | tag | box | contents |
 * | --- | --- | --- | --- |
 * | `location-dropdown__aria-items` | `ul` | **0x0** | `li` mirrors for screen readers |
 * | `location-dropdown auto-complete` | `div` | 855x400 | the real, clickable options |
 *
 * The mirror comes **first in document order**, so `querySelector` returned it —
 * the same trap `firstMatch` exists for in `extract.ts`, where a comma list
 * looks like a preference order and is not one. The driver then found a mirror
 * `li` whose text contains the code, clicked it, and nothing happened: it is a
 * screen-reader element with no handler. That is the whole of the reported
 * failure — "it does a dropdown for location and we aren't picking it".
 */
const LOCATION_MENU = '.location-dropdown.auto-complete';
/**
 * Every copy of the menu, for the readback to ignore.
 *
 * Both must be excluded or the check passes on a click that did nothing: the
 * mirror renders the branch name too, so it satisfies a search of "the page
 * outside the visible menu" all by itself.
 */
const LOCATION_MENU_ANY = '[class*="location-dropdown"]';
/**
 * A suggestion's clickable element.
 *
 * The `<li class="location-group__item">` around it is **not** one — it carries
 * `role="option"` and swallows a click silently, exactly as National's `<li>`
 * does. Measured: clicking the inner `button` closes both menus and renders the
 * branch outside them; clicking the `li` leaves the menu open.
 */
const LOCATION_OPTION = 'li.location-group__item button';
/** The airport code, rendered on its own: `<small class="airport-code">TPA</small>`. */
const OPTION_CODE = '.airport-code';
/** The branch name, rendered on its own: `<span class="location-name">…</span>`. */
const OPTION_NAME = '.location-name';

/**
 * The airport code an option is offering, or `''`.
 *
 * Read from its own element rather than matched out of the option's text,
 * because the option's text **depends on whether the browser computed layout**.
 * Measured on the live form: the code is glued to the branch name —
 * `Tampa International AirportTPA Tampa, FL, 33607 US` — in `textContent` and
 * in `innerText`, so the character before `TPA` is a letter and `hasToken`
 * refuses it.
 *
 * A probe tab is saved from that by accident. It has no layout, so `innerText`
 * is `''` and `textOf` falls back to `visibleText`, which joins *text nodes*
 * with a space and re-separates the two. So `hasToken` happens to work in the
 * probe and fails everywhere else — in a foreground tab, in any future run with
 * layout, and the moment Enterprise puts the name and code in one text node.
 *
 * Depending on that is depending on a bug cancelling a bug. This element holds
 * the code alone, so the match is exact and the same either way.
 */
function optionCode(option: Element): string {
  return textOf(option.querySelector(OPTION_CODE)).toUpperCase();
}

/**
 * **There is deliberately no fallback matcher**, and the reason is the readback
 * rather than tidiness.
 *
 * A text-based fallback was written for the case where `.airport-code` is
 * renamed, allowing the code to be preceded by a letter so `AirportTPA` still
 * matched. It had to go, because **nothing downstream can catch it picking the
 * wrong branch.** `expected` is derived from the option that matched, so the
 * post-click check confirms "the branch I clicked is on the page" and never
 * "the branch is TPA" — and unlike National there is no second chance at it:
 * measured on the live form, the selected branch renders its *name* outside the
 * menu but not its code, so the readback has no code to compare.
 *
 * So a loosened match would select a neighbouring option that merely mentions
 * `TPA`, verify it, and price it. That is a real rental at the wrong branch
 * reported as the user's — the failure class this repo holds to be worse than
 * no quote at all.
 *
 * If `.airport-code` disappears, the right outcome is a loud `form-fill` with
 * `offered=` naming what the lookup actually returned, which the diagnostics now
 * give. Fail, and be told why.
 */

/**
 * What the page looked like when the location step ran out of time.
 *
 * Facts, never a verdict — ported from `national.ts`, where the same timeout was
 * diagnosed wrongly twice from the outside before it carried any evidence. This
 * driver arrived without it and immediately cost a live run the same way: a user
 * reported Enterprise "failing to select the location" and the message said only
 * that it had, which is consistent with a lost keystroke, a menu that answered
 * with nothing, a field the widget cleared, and a click that selected nothing.
 *
 * These are the observations that separate those: a field that lost its value
 * means the widget cleared it, a menu present with no options means the lookup
 * ran and returned nothing, `offered` naming other airports means it ran and
 * disagreed with us, and no menu at all after several nudges means the events
 * are not reaching the component.
 *
 * **`menu` reports the visible list only, and that is what makes it mean
 * anything.** The first version of this read `[class*="location-dropdown"]`,
 * which also matches the screen-reader mirror — an element present whether or
 * not the autocomplete ever heard us. So `menu=absent` was unreachable and
 * `options=0` was ambiguous across the exact two causes this exists to
 * separate. `aria` reports the mirror separately, where it is a fact rather
 * than a disguise.
 *
 * `widget` reports `#cid` rather than the location field because **the whole
 * form is widget-built** — measured 2026-08-12 by fetching `/en/reserve.html`:
 * 200, 453,800 bytes, brand nav and `booking-widget` styles present, and
 * **zero `<input>` elements**. (The positive facts are recorded because a 403
 * body would also contain no inputs, and `CLAUDE.md` notes Enterprise serves
 * 403s to `curl`.) So the location input existing is already proof the widget
 * rendered, and `#cid` disappearing mid-step means it has since torn that
 * render down.
 *
 * Page-supplied strings are capped. `PROBE_FAILED`'s `message` reaches
 * `chrome.storage.session` without the truncation `sanitizeReport` applies to
 * `title` and `finalPath`, so an unbounded field value would put an arbitrary
 * amount of page text into a quota-limited store.
 */
const STATE_TEXT_CAP = 80;

/**
 * The location field as it stands *now*.
 *
 * Never the node `fillLocation` captured. The retry re-queries because this
 * form is entirely widget-built and a re-render swaps the input out; anything
 * reading the captured reference describes something already abandoned — after
 * a remount it reports `field=held` off a detached input while the live field
 * is empty, inverting every inference drawn from it.
 */
function liveField(ctx: DriveContext): HTMLInputElement | undefined {
  return ctx.doc.querySelectorAll<HTMLInputElement>('input[name="location-search"]')[0];
}

function autocompleteState(
  ctx: DriveContext,
  iata: string,
  nudges: number,
  elapsed: number,
): string {
  const field = liveField(ctx);
  const menu = ctx.doc.querySelector(LOCATION_MENU);
  const options = menu ? [...menu.querySelectorAll(LOCATION_OPTION)] : [];
  // Each code sliced, not just the list truncated. `optionCode` returns whatever
  // `.airport-code` holds, and if that class lands on a wider element it returns
  // arbitrary page text — six unbounded strings would defeat the cap entirely.
  const codes = options
    .map((el) => optionCode(el).slice(0, 8))
    .filter(Boolean)
    .slice(0, 6)
    .join(',');
  return [
    `field=${
      !field
        ? 'gone'
        : field.value === iata
          ? 'held'
          : JSON.stringify(field.value.slice(0, STATE_TEXT_CAP))
    }`,
    `menu=${menu ? 'present' : 'absent'}`,
    `options=${options.length}`,
    `offered=${codes || 'none'}`,
    `aria=${ctx.doc.querySelector('.location-dropdown__aria-items') ? 'present' : 'absent'}`,
    `fields=${ctx.doc.querySelectorAll('input[name="location-search"]').length}`,
    `widget=${ctx.doc.querySelector('#cid') ? 'present' : 'absent'}`,
    `nudges=${nudges}`,
    `waited=${Math.round(elapsed / 1000)}s`,
  ].join(' ');
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
 *
 * **What the first live run actually hit was the wrong container**, and the
 * retry below was a fix for a different disease. The menu selector matched the
 * screen-reader mirror rather than the visible list, so the driver clicked an
 * element with no handler and then waited out its budget for a chip that could
 * never appear — see `LOCATION_MENU`. Two further faults sat behind it, neither
 * of which the run got far enough to reach: the readback excluded only one of
 * the two menus, so it would have passed on a click that selected nothing; and
 * the option's code is glued to its branch name, which `hasToken` refuses in
 * any tab that has layout (see `optionCode`). All three measured on the live
 * form 2026-08-12.
 *
 * **The keystroke is retried anyway**, because `awaitHydration` returning is
 * still not proof the location component is *listening*: it waits for `#cid`,
 * and a widget that has rendered its inputs may not have wired their handlers.
 * A single `input` event that lands on nothing leaves no menu to wait for.
 * National met that and fixed it the same way — focus the field, re-announce
 * the value periodically. The retry never clears the field: a missing value is
 * set (the component wiped it) and an intact one is only nudged, which leaves a
 * lookup in flight alone. Clearing and retyping is what broke every live run on
 * National; see `RETRY_INTERVAL_MS`.
 *
 * `RETRY_INTERVAL_MS` is 4 s against a **measured** Enterprise lookup of about
 * 1.5 s — typed into a hidden, unfocused tab, six options back on the next
 * poll. So the nudge cannot land on a lookup that has not had its chance,
 * which was the concern National's docstring records. It is no longer the
 * inference it was when this was ported.
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

  pickup.focus();
  setNativeValue(pickup, iata);

  let nudges = 0;
  const startedAt = ctx.now();
  const option = await waitWithRetry(
    ctx,
    `the autocomplete to offer ${iata}`,
    () => {
      const menu = ctx.doc.querySelector(LOCATION_MENU);
      if (!menu) return null;
      const offered = [...menu.querySelectorAll<HTMLElement>(LOCATION_OPTION)];
      if (offered.length === 0) return null;
      return offered.find((el) => optionCode(el) === iata) ?? null;
    },
    // **The retry is deliberately unconditional**, and two attempts at gating it
    // were both wrong. The original `offered.length > 0` branch returned `null`
    // down both arms, so it suppressed nothing and merely claimed to. Replacing
    // it with a `heard` latch was worse: `setNativeValue` sets `.value`
    // synchronously whether or not any component is listening, so a menu left
    // open from a restored previous search — Enterprise keeps its itinerary in
    // session state — latches the flag on the first poll and retires the retry
    // before the dropped keystroke it exists for has even been noticed.
    //
    // Nothing needs gating. The concern `RETRY_INTERVAL_MS` records is a nudge
    // cancelling a lookup already in flight, and Enterprise's lookup is
    // *measured* at about 1.5s against this 4s interval — so every lookup has
    // had its chance before another nudge lands. `nudges` then also reads as
    // elapsed/4s, which makes it a throttling gauge in the diagnostics rather
    // than an ambiguous one.
    () => {
      nudges += 1;
      // Re-query rather than reuse `pickup`: this form is entirely widget-built,
      // so a re-render can swap the input out from under us, and nudging the
      // detached node would announce the value to nothing forever.
      const live = liveField(ctx);
      if (!live) return;
      if (live.value === iata) nudgeInput(live);
      else setNativeValue(live, iata);
    },
  ).catch((error: unknown) => {
    // Enriched rather than re-worded. Everything here is something only the
    // failing page can report, and the popup keeps the raw message in a tooltip
    // — so the next failure arrives as evidence rather than as another round of
    // guessing about a tab nobody can inspect.
    if (!(error instanceof DriverError)) throw error;
    throw new DriverError(
      error.failure,
      `${error.message} (${autocompleteState(ctx, iata, nudges, ctx.now() - startedAt)})`,
    );
  });

  // The branch name from its own element, not sliced out of the option's text.
  // `Tampa International AirportTPA …` has no separator to split on — see
  // `optionCode` — so the old `split(/\bTPA\b/)` returned the whole string and
  // the readback then looked for a name that included the code and the city.
  const name = textOf(option.querySelector(OPTION_NAME)) || textOf(option).split(iata)[0]?.trim();

  option.click();

  // Falls back to the code when the option carried no name at all, rather than
  // checking against an empty string — which would succeed on every page,
  // including a blank one.
  const expected = name || iata;

  await waitFor(ctx, `the form to show the ${iata} branch it was given`, () => {
    // Deliberately *not* a search of the whole page. The suggestion menu
    // contains this exact name — it is where the name came from — so a body-wide
    // `includes` passes whether or not the click did anything, which is the
    // difference between verifying a selection and verifying that a dropdown
    // once opened. The proof is the name rendered somewhere no menu is: the form
    // shows the chosen branch as a chip beside the field.
    //
    // *Every* menu, not the visible one. The screen-reader mirror renders the
    // same branch name, so excluding only `LOCATION_MENU` left this passing on a
    // click that selected nothing — the very failure the paragraph above claims
    // to prevent, arriving through the second copy.
    const menus = [...ctx.doc.querySelectorAll(LOCATION_MENU_ANY)];
    return textOutside(ctx.doc.body, menus).includes(expected) || null;
  }).catch((error: unknown) => {
    // The click landing on nothing is a *different* failure from the menu never
    // opening, and until this catch existed the two were equally silent. The
    // facts that separate them: a menu still open means the click did not even
    // dismiss it, and the expected name being absent from the whole document —
    // menus included — means the suggestion itself went away rather than failing
    // to be promoted into a chip.
    if (!(error instanceof DriverError)) throw error;
    const live = liveField(ctx);
    const state = [
      `expected=${JSON.stringify(expected.slice(0, STATE_TEXT_CAP))}`,
      `menu=${ctx.doc.querySelector(LOCATION_MENU) ? 'still-open' : 'closed'}`,
      `aria=${ctx.doc.querySelector('.location-dropdown__aria-items') ? 'present' : 'absent'}`,
      `anywhere=${textOutside(ctx.doc.body, null).includes(expected)}`,
      `field=${live ? JSON.stringify(live.value.slice(0, STATE_TEXT_CAP)) : 'gone'}`,
    ].join(' ');
    throw new DriverError(error.failure, `${error.message} (${state})`);
  });
}

/** The pick-up date toggle. Stable id, unlike the time selects below it. */
const PICKUP_TOGGLE = '#pickupCalendarFocusable';
/** The return date toggle. Enterprise calls it "dropoff" here and "Return" on screen. */
const RETURN_TOGGLE = '#dropoffCalendarFocusable';
/** One day in the open calendar. Carries `data-test-id="MM/DD/YYYY"`. */
const DAY = 'button.rs-calendar__day';
/** The month-paging arrows. Two of each — one per displayed month. */
const ARROW = 'button.calendar-control-arrow';
/** "August 2026", above each displayed month. */
const MONTH_HEADER = '.calendar-control-header';

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

/**
 * Two years of paging before giving up.
 *
 * Past any rental anybody books, and far short of clicking forever if the
 * control stops advancing. Same bound and same reasoning as National's.
 */
const MAX_MONTH_STEPS = 24;

/**
 * Consecutive polls with no readable month header before giving up on the
 * calendar. Two seconds in a painted tab, about eight in a throttled one —
 * long enough for a grid mid-redraw, far short of the budget.
 */
const UNREADABLE_HEADER_POLLS = 8;

/**
 * Enterprise's own name for a day: `08/13/2026` from `2026-08-13`.
 *
 * Exported for the tests, which pin the conversion rather than the calendar —
 * a US-format date built from ISO parts is exactly the kind of thing that
 * silently transposes month and day.
 */
export function calendarId(iso: string): string {
  const { year, month, day } = isoParts(iso);
  return `${month}/${day}/${year}`;
}

/** "August 2026" as a sortable number, or null if unreadable. */
function monthKey(label: string): number | null {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(label.replace(/\s+/g, ' ').trim());
  if (!match) return null;
  const index = MONTH_NAMES.indexOf(match[1] ?? '');
  if (index < 0) return null;
  return Number(match[2]) * 12 + index;
}

/** The month a `MM/DD/YYYY` id falls in, on the same scale as `monthKey`. */
function monthOf(id: string): number {
  const [month, , year] = id.split('/');
  return Number(year) * 12 + (Number(month) - 1);
}

/** The months on screen right now. */
function shownMonths(ctx: DriveContext): number[] {
  return [...ctx.doc.querySelectorAll<HTMLElement>(MONTH_HEADER)]
    .map((el) => monthKey(textOf(el)))
    .filter((key): key is number => key !== null);
}

/**
 * The clickable cell for a date, if one is on screen.
 *
 * **Filters out disabled duplicates, and that is the whole point of this
 * function.** The two month grids overlap: September 1st appears both as a
 * greyed spillover cell at the foot of August and as a real cell in September,
 * so `querySelector` alone returns *two* matches and the first is the dead one.
 * Taking it would report a perfectly bookable date as one Enterprise refuses.
 *
 * A date that is present but disabled everywhere is a different answer from one
 * that is not on screen at all — the first is a refusal, the second means page
 * the calendar — so the caller distinguishes them rather than this returning
 * null for both.
 */
function dayCell(ctx: DriveContext, id: string): HTMLButtonElement | null {
  const cells = [...ctx.doc.querySelectorAll<HTMLButtonElement>(`${DAY}[data-test-id="${id}"]`)];
  return cells.find((cell) => !cell.disabled) ?? null;
}

/** Whether the date is on screen at all, enabled or not. */
function dayPresent(ctx: DriveContext, id: string): boolean {
  return ctx.doc.querySelector(`${DAY}[data-test-id="${id}"]`) !== null;
}

/**
 * A usable paging arrow, or null.
 *
 * **Disabled is spelled `invisible` here, not `disabled`.** At the current
 * month "Previous" is rendered as `arrow-left invisible` with its `disabled`
 * property still false, so a `.disabled` test reads an unusable control as
 * usable and pages against a wall until the budget is gone. Measured on the
 * live form.
 */
function arrow(ctx: DriveContext, want: 'Next' | 'Previous'): HTMLButtonElement | null {
  return (
    [...ctx.doc.querySelectorAll<HTMLButtonElement>(ARROW)].find(
      (el) =>
        new RegExp(want, 'i').test(el.getAttribute('aria-label') ?? '') &&
        !el.classList.contains('invisible') &&
        !el.disabled,
    ) ?? null
  );
}

/** Open a calendar, re-clicking if the first click landed while it was settling. */
async function openCalendar(ctx: DriveContext, toggle: string, which: string): Promise<void> {
  const button = ctx.doc.querySelector<HTMLElement>(toggle);
  if (!button) throw new DriverError('form-fill', `no ${which} date control on the form`);
  if (!ctx.doc.querySelector(DAY)) button.click();
  // Only re-clicked while closed: this toggle closes the calendar when clicked
  // a second time, so an unconditional retry would shut what it just opened.
  await waitWithRetry(
    ctx,
    `the ${which} calendar to open`,
    () => ctx.doc.querySelector(DAY),
    () => {
      if (!ctx.doc.querySelector(DAY)) button.click();
    },
  );
}

/** Page the calendar to a date's month and click it. */
async function clickDay(ctx: DriveContext, id: string, which: string): Promise<void> {
  const want = monthOf(id);
  // The months that were on screen when an arrow was last clicked, so the
  // next click waits for the grid to have moved. The loop polls every 250ms
  // and a painted tab honours that, which is faster than a React re-render:
  // an arrow clicked again before the headers change pages twice, overshoots,
  // pages back, and can oscillate to the step bound and report "timed out
  // reaching". The months on screen are the only honest signal that the last
  // click landed. Review of PR #69 found it; a fixture with a slow repaint
  // pins it.
  let pagedFrom: string | null = null;
  // Arrow clicks, not polls: with one click per redraw most iterations are
  // spent waiting, and counting those against a two-year page budget would
  // exhaust it on a trip eight months out. The deadline bounds the waiting.
  let paged = 0;
  // Polls in a row on which no month header could be read. A calendar whose
  // headers Enterprise has renamed or reformatted would otherwise be waited
  // on until the deadline and reported as "timed out reaching", which says
  // nothing about why; this says what the headers held.
  let unreadable = 0;

  for (;;) {
    const cell = dayCell(ctx, id);
    if (cell) {
      cell.click();
      return;
    }
    const shown = shownMonths(ctx);
    if (shown.length === 0) {
      unreadable += 1;
      if (unreadable >= UNREADABLE_HEADER_POLLS) {
        const seen = [...ctx.doc.querySelectorAll<HTMLElement>(MONTH_HEADER)]
          .map((el) => JSON.stringify(textOf(el).slice(0, 40)))
          .join(',');
        throw new DriverError(
          'form-fill',
          `enterprise's calendar shows no readable month header (headers=${seen || 'none'}), so it cannot be paged to ${id}`,
        );
      }
    } else {
      unreadable = 0;
    }
    if (dayPresent(ctx, id) && shown.includes(want)) {
      // Dead in every grid *and its own month is on screen*: the vendor's
      // answer, not a paging problem. Enterprise disables dates in the past and
      // beyond its booking horizon, and no amount of paging changes either.
      //
      // The month test is load-bearing. A spillover cell carries the id of a
      // day in the month *after* the displayed one, disabled — so without it a
      // trailing spillover at the foot of the second grid reads the 1st of a
      // month not yet shown as refused, and every trip starting there fails
      // `form-fill` before the Next arrow is ever clicked. Review of PR #69
      // found this by reading; the fixture now renders that spillover too.
      throw new DriverError('form-fill', `enterprise will not accept the ${which} date ${id}`);
    }

    if (shown.length > 0) {
      const direction =
        want > Math.max(...shown) ? 'Next' : want < Math.min(...shown) ? 'Previous' : null;
      // Neither past nor before what is displayed, yet no cell exists — the
      // grid is still redrawing. Fall through to the sleep and look again.
      const key = shown.join(',');
      if (direction && key !== pagedFrom) {
        const control = arrow(ctx, direction);
        if (!control) {
          throw new DriverError(
            'form-fill',
            `enterprise's calendar will not page ${direction.toLowerCase()} to reach ${id}`,
          );
        }
        if (paged >= MAX_MONTH_STEPS) {
          throw new DriverError(
            'form-fill',
            `enterprise's calendar paged ${paged} times without reaching ${id} (headers now ${shown.join(', ')})`,
          );
        }
        control.click();
        paged += 1;
        pagedFrom = key;
      }
    }

    if (ctx.now() >= ctx.deadline) break;
    await ctx.sleep(POLL_MS);
  }
  throw new DriverError('form-fill', `timed out reaching ${id} in the ${which} calendar`);
}

/**
 * What a toggle says is selected, as `MM/DD/YYYY`.
 *
 * Read from `aria-label` ("Selected Pick-Up Date 08/13/2026") rather than from
 * the rendered text ("13 Aug 2026"). Two reasons, and the second is the one
 * that matters: the attribute is already in the format we asked for, so no
 * month-name parsing can go wrong — and **attributes survive a minimised tab**,
 * where `innerText` is `''`. A text-based readback would compare `''` against
 * `''` on an empty page and pass. See "Reading a page that has no layout" in
 * `docs/driving-a-vendor-form.md`.
 */
function selectedDate(ctx: DriveContext, toggle: string): string | null {
  const label = ctx.doc.querySelector(toggle)?.getAttribute('aria-label') ?? '';
  return /(\d{2}\/\d{2}\/\d{4})/.exec(label)?.[1] ?? null;
}

/**
 * Set the trip's dates, and confirm the form took them.
 *
 * **This is a range picker, not two independent date fields**, which is the
 * single thing worth knowing before touching it and the trap National's first
 * driver fell into. Measured on the live form:
 *
 * | after | pick-up | return |
 * | --- | --- | --- |
 * | (default) | 08/13/2026 | 08/14/2026 |
 * | click 08/20 in the pick-up calendar | **08/20/2026** | *(blank)* |
 * | click 08/24 in the return calendar | 08/20/2026 | **08/24/2026** |
 *
 * So choosing a pick-up **clears the return** and closes the calendar; the
 * return is a second pass through a freshly opened one. A driver that set the
 * pick-up, checked it, and stopped would submit a form with no return date at
 * all.
 *
 * The verification is the point of the step, not decoration. Both toggles are
 * read back from `aria-label` and compared against the trip, so a date the
 * widget silently declined fails the quote instead of pricing whatever the form
 * happened to be holding. That is what this function refused to do until it was
 * measured, and the reason Enterprise sat `searchable: false` for so long.
 */
export async function applyDates(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);
  const pickup = calendarId(trip.pickupDate);
  const dropoff = calendarId(trip.dropoffDate);

  await openCalendar(ctx, PICKUP_TOGGLE, 'pick-up');
  await clickDay(ctx, pickup, 'pick-up');

  // Deliberately not asserting the return is blank here. That it clears is
  // measured, but it is the widget's business rather than ours, and a check
  // that fails when Enterprise makes its range picker tidier would cost a good
  // quote to prove a point we do not need proved.
  await waitFor(
    ctx,
    `the form to show the pick-up date ${pickup}`,
    () => selectedDate(ctx, PICKUP_TOGGLE) === pickup,
  );

  // The pick-up calendar closes itself on the pick, and the return pass must
  // not start until it has. `openCalendar` only clicks its toggle when no day
  // cell is on screen and `dayCell` looks document-wide, so a pick-up grid
  // still mounted would swallow both: the return toggle never clicked, the
  // return day clicked into the pick-up calendar, and the pick-up moved.
  await waitFor(ctx, 'the pick-up calendar to close', () =>
    ctx.doc.querySelector(DAY) ? null : true,
  );

  await openCalendar(ctx, RETURN_TOGGLE, 'return');
  await clickDay(ctx, dropoff, 'return');

  // Both, together, at the end. Picking the return is what can disturb the
  // pick-up — the widget re-derives the range from the two clicks — so checking
  // only the return would miss a pick-up that moved underneath it.
  await waitFor(ctx, `the form to show the trip ${pickup}..${dropoff}`, () => {
    return (
      selectedDate(ctx, PICKUP_TOGGLE) === pickup && selectedDate(ctx, RETURN_TOGGLE) === dropoff
    );
  });
}

/**
 * The two time dropdowns, found by `aria-label`.
 *
 * **Their ids are freshly generated UUIDs** — `9b20166e-c5ec-…` on the load
 * this was measured against — so an id selector would work exactly once. The
 * `aria-label`s ("Pick-Up Time Selector", "Return Time Selector") are stable
 * and are the only durable handle on the page.
 */
function timeSelect(ctx: DriveContext, which: 'Pick-Up' | 'Return'): HTMLSelectElement | null {
  return (
    [...ctx.doc.querySelectorAll<HTMLSelectElement>('select')].find((el) =>
      new RegExp(`${which}\\s+Time`, 'i').test(el.getAttribute('aria-label') ?? ''),
    ) ?? null
  );
}

/**
 * The option holding a time, accepting either zero-padded or bare hours.
 *
 * Measured 2026-10-26: the hours are **bare** — `9:00 AM`, not `09:00 AM` —
 * in 49 options from `12:00 AM` at half-hour steps, with `value` and text
 * identical, behind a `default` option reading "Please select a pick-up time
 * to continue." Both spellings stay matched anyway: the padded form costs
 * nothing, and a vendor that pads its hours one day should not fail every
 * quote for it.
 */
function timeOption(select: HTMLSelectElement, hhmm: string): HTMLOptionElement | null {
  const { hour, minute, ampm } = clock12(hhmm);
  const wanted = new Set([
    `${hour}:${minute} ${ampm}`.toUpperCase(),
    `${Number(hour)}:${minute} ${ampm}`.toUpperCase(),
  ]);
  return (
    [...select.options].find(
      (option) =>
        wanted.has(option.value.trim().toUpperCase()) ||
        wanted.has((option.text || '').trim().toUpperCase()),
    ) ?? null
  );
}

/**
 * Set the trip's pick-up and return times, and confirm the form took them.
 *
 * **Not cosmetic, and not optional.** The form defaults to 12:00 PM at both
 * ends. Leaving that alone turns an 09:00–17:00 rental into a different
 * rental of a different length, and Enterprise prices by duration — so the
 * quote would be real, plausible and about somebody else's trip. Exactly the
 * failure `applyDates` refused to ship for, one field along.
 *
 * A time the dropdown does not offer fails the quote rather than falling back.
 * Enterprise's list is half-hourly, so an 09:15 pick-up has no option at all,
 * and rounding it silently would reintroduce the same lie in miniature.
 *
 * **The selects were observed but never driven**, which is why the readback
 * below is a `waitFor` rather than an assertion: `setNativeValue` is the right
 * recipe for a React-controlled `<select>` and works on every other field on
 * this form, but that it takes *here* is inference. If it does not, this fails
 * `form-fill` loudly instead of submitting the default.
 */
export async function applyTimes(ctx: DriveContext): Promise<void> {
  const trip = carTrip(ctx);

  for (const [which, hhmm] of [
    ['Pick-Up', trip.pickupTime],
    ['Return', trip.dropoffTime],
  ] as const) {
    const select = timeSelect(ctx, which);
    if (!select) {
      throw new DriverError('form-fill', `no ${which} time control on the form`);
    }

    let option: HTMLOptionElement | null;
    try {
      option = timeOption(select, hhmm);
    } catch (error) {
      throw new DriverError('form-fill', error instanceof Error ? error.message : String(error));
    }
    if (!option) {
      throw new DriverError(
        'form-fill',
        `enterprise offers no ${which} time of ${hhmm} — refusing rather than renting for a different span`,
      );
    }

    const value = option.value;
    setNativeValue(select, value);
    // `waitForSettled`, not `waitFor`: the latter reads before its first sleep,
    // and `setNativeValue` has already made `select.value` equal to `value` on
    // this tick — so it would be checking our own assignment rather than the
    // form's acceptance of it, and would pass on a control that reverts. That
    // is the noon default going out as the user's trip.
    await waitForSettled(
      ctx,
      `the ${which} time control to keep ${hhmm}`,
      () => timeSelect(ctx, which)?.value === value,
    );
  }
}

/** Put the code in the Corporate Account Number field, and confirm it stuck. */
export async function fillAccountNumber(ctx: DriveContext): Promise<void> {
  const cid = ctx.doc.querySelector<HTMLInputElement>('#cid');
  if (!cid) throw new DriverError('form-fill', 'no Corporate Account Number field on the form');
  setNativeValue(cid, ctx.code);
  // Read back rather than trust the write, and *wait* for the read-back rather
  // than taking it immediately. A controlled input that rejected the value looks
  // identical from here otherwise, and submitting without a code prices the
  // retail rate and reports it as the company's.
  //
  // This comment described the wait correctly and the code did not do it:
  // `waitFor` reads before its first sleep, so it saw the value `setNativeValue`
  // had just written and returned on the same tick — exactly the "tests our
  // assignment rather than the page's acceptance" it warns against.
  // **Re-queried every poll, not closed over.** Reading `cid` back through the
  // captured reference verifies a node that may no longer be in the document:
  // this runs straight after `applyDates` and `applyTimes` have dispatched four
  // events into a React form, which is exactly when a section re-render is
  // likely, and a remounted `#cid` leaves the detached node still holding the
  // code while the live field is empty. The driver then reports success, the
  // form submits with no account number, Enterprise answers with the *retail*
  // rate, `#car_select` appears, and the popup prints that as the company's
  // discounted price with a "form filled" badge beside it.
  //
  // `applyTimes` re-queries for this reason; this is the same fix, at the field
  // where getting it wrong is most expensive.
  await waitForSettled(
    ctx,
    'the account number field to keep the code',
    () => ctx.doc.querySelector<HTMLInputElement>('#cid')?.value === ctx.code,
  );
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
 * The account-holder check lives in `verifyResults`, not here: it is a claim
 * about the results page, and that step is the one that runs against whichever
 * document holds the results.
 */
export async function submitSearch(ctx: DriveContext): Promise<void> {
  const button = [...ctx.doc.querySelectorAll<HTMLElement>('button, input[type="submit"]')].find(
    (el) => /browse vehicles/i.test(textOf(el) || (el as HTMLInputElement).value || ''),
  );
  if (!button) throw new DriverError('form-fill', 'no "Browse Vehicles" button on the form');

  // Mark this tab as the one that submitted this code, *before* the click,
  // so a re-injected probe on the results view can tell its own search from a
  // results page Enterprise restored from session state. See `drive`.
  markSubmitted(ctx);
  button.click();

  await waitFor(
    ctx,
    'Enterprise to answer the search',
    () => {
      // `visibleText`, not `textOf`: the latter prefers `innerText`, which
      // forces style and layout of the whole document on every poll — in the
      // one tab that is painted, while Enterprise is rendering its cards.
      refuseIfAnswered(visibleText(ctx.doc.body));
      return ctx.doc.location?.hash.includes(RESULTS_HASH) || null;
    },
    'form-submit',
  );
}

/**
 * The account holder, as the results page names it.
 *
 * Measured 2026-10-26. With IBM's `5666666` the header renders
 * `<button class="cta … contract-name__button" aria-label="I B M CORP (USA)">`
 * inside `#codebanner-container` — three copies, one per breakpoint — and the
 * cards carry a "Custom Rate" tag. The identical search with an empty account
 * number leaves `#codebanner-container` with no children at all, no button
 * anywhere, and no "Custom Rate". The class name is the handle rather than
 * the container, because an empty container is also what a page shows while
 * it is still thinking.
 */
const CONTRACT_NAME = '.contract-name__button, .contract-name-text';
/*
 * Two shapes, both measured. IBM's banner is the linked kind — a button with
 * the name as its `aria-label` and text. Fortive's (`XZ15CH7`, 2026-10-27) is
 * `code-banner--no-links`: the same `#codebanner-container`, and the name in
 * `<p class="contract-name-text">` with no button anywhere. The first selector
 * alone failed that quote `discount-missing` on a page that named the account
 * in its header.
 */
/*
 * Measured not to leak between searches in one profile, which is the question
 * a session-state vendor raises: the no-code control above was run in the same
 * Chrome profile *after* the IBM search had rendered the banner, on a fresh
 * load of the form, and the container came back empty. A banner inherited from
 * an earlier quote's contract would defeat this check, and it did not happen.
 */

/** One vehicle class on the results page. 73 of them on the measured page. */
const RESULT_CARD = 'section.car-item__wrapper';

/**
 * How long a results page gets to name its account after it has listed cars.
 *
 * On the live page the banner and the cards arrived on the same poll, so this
 * is slack for a slower render rather than a measured gap. Bounded rather than
 * left to the quote's deadline because a code Enterprise silently ignores is
 * the case this exists to catch, and spending the whole remaining budget to
 * say "no discount" would turn a ten-second answer into a minute's wait.
 *
 * Ten seconds rather than three because of *where* this runs: after
 * `releasePaint`, in a tab that is back in a minimised window, where timers
 * are throttled to about one tick a second. Three seconds there is three
 * reads, and a false `discount-missing` throws away a good quote.
 */
const BANNER_GRACE_MS = 10_000;

/**
 * Confirm a search actually ran and was priced under the account we gave it.
 *
 * Enterprise submits in place — its results are a `#car_select` fragment on the
 * same document — so unlike National there is no navigation to survive and
 * `submitSearch` already sees its own outcome. This exists so the contract is
 * one shape for every driver, and it deliberately does **not** reuse
 * `submitSearch`: that clicks the button, and a verification step that submits
 * the form again is a second search per quote.
 *
 * The account check is the part that matters. A code Enterprise ignores rather
 * than refuses gives a real results page at the retail rate — measured: the
 * no-code search prices Economy at exactly the $55.13 IBM's code does — and
 * without this the popup would print that as the company's rate under a
 * "form filled" badge. `discount-missing` rather than `code-rejected`: an
 * absent element is our inference, not the vendor's sentence, and it is
 * deliberately never remembered. See `rejected-codes.ts` for why that split
 * is load-bearing.
 */
export async function verifyResults(ctx: DriveContext): Promise<DriveEvidence> {
  await waitFor(
    ctx,
    'Enterprise to be showing a results page',
    () => {
      // The answer can land after `submitSearch` returned, on the document
      // waiting for results; same sentences, same verdicts.
      refuseIfAnswered(visibleText(ctx.doc.body));
      return ctx.doc.location?.hash.includes(RESULTS_HASH) || null;
    },
    'form-submit',
  );
  await waitFor(
    ctx,
    'Enterprise to list vehicle classes',
    () => ctx.doc.querySelector(RESULT_CARD),
    'form-submit',
  );
  // A shortened deadline, never a longer one: the grace is capped by the
  // quote's own budget so this step can never outlive the probe.
  const grace = { ...ctx, deadline: Math.min(ctx.deadline, ctx.now() + BANNER_GRACE_MS) };
  const banner = await waitFor(
    grace,
    'Enterprise to name the account the search was priced under (it listed cars but no contract)',
    () => ctx.doc.querySelector<HTMLElement>(CONTRACT_NAME),
    'discount-missing',
  );
  // The name rides on the quote's report: `I B M CORP (USA)` is the aria-label
  // and the visible text both, so take whichever the page filled.
  const account = (banner.getAttribute('aria-label') || textOf(banner)).trim().slice(0, 60);
  return account ? { account } : {};
}

export const enterpriseDriver: FormDriver = {
  startUrl: () => START_URL,
  startPath: new URL(START_URL).pathname,
  verifyResults,
  async drive(ctx) {
    // A document already showing the results of *this tab's own search* has
    // nothing to drive. The probe re-runs on every document and gates on
    // `startPath`, which for Enterprise is the *same* path as the results
    // view — only `#car_select` tells them apart — so a reload of the results
    // page (a consent bounce, an SPA `location.reload`) would otherwise spend
    // the whole budget waiting for a `#cid` this view never renders, and fail
    // a quote whose search had already succeeded.
    //
    // The hash alone is not enough, and the first version of this gate used
    // only that. Enterprise keeps its itinerary in session state, so a results
    // view could in principle be *restored* rather than earned — the previous
    // quote's search, or the user's own — and `verifyResults` checks that an
    // account is named, not whose. Skipping the drive on that view would price
    // somebody else's search under this code with a "form filled" badge. So
    // the skip needs this tab's own marker for this code (see `SUBMITTED_KEY`);
    // anything else drives from the top and fails loudly on a view without a
    // form. The paint hold is released here too, as it is after a submit.
    if (ctx.doc.location?.hash.includes(RESULTS_HASH) && submittedHere(ctx)) {
      ctx.releasePaint?.();
      return;
    }
    await awaitHydration(ctx);
    await fillLocation(ctx);
    // The itinerary before the code, and both before the submit: there is no
    // point typing a discount code into a form that is about to be submitted
    // for the wrong trip, and failing here means a half-driven form is never
    // sent. `applyDates` used to throw unconditionally and this ordering is
    // what made that safe; it still holds now that both steps really run.
    await applyDates(ctx);
    await applyTimes(ctx);
    await fillAccountNumber(ctx);
    await submitSearch(ctx);
    // Only now, and deliberately not straight after `awaitHydration`. What was
    // measured is that the *mount* needs a painted tab; the autocomplete menu
    // and the calendar are lazily-rendered popups on the same page and may want
    // one too. Releasing at the mount would move the identical symptom one step
    // later, and finding that out costs a live run. Held until the search is
    // submitted, which is the last thing that touches the form.
    ctx.releasePaint?.();
  },
};
