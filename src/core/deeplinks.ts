import type { CarTrip, HotelTrip, Trip, VendorId } from './types.js';

/**
 * Deep links that pre-apply a discount code on each vendor's own search page.
 *
 * None of these vendors publish a documented query-string contract, so every
 * template here is reverse-engineered from the public booking flows and is
 * expected to rot. That is why they all live in this one file behind a single
 * `buildDeepLink` call, and why each carries a `confidence` flag the popup
 * surfaces to the user.
 *
 * To fix one, follow README's "Fixing a deep link" — and note that copying the
 * URL is only half of it. The step that matters is **replaying** it: change one
 * parameter and confirm the page follows. A URL that merely loads proves
 * nothing, because the search may be coming from the session rather than the
 * address bar, which is exactly how Enterprise looked plausible while carrying
 * no search at all. `tests/deeplinks.test.ts` pins the shape of each URL so a
 * change is deliberate rather than accidental.
 */

/**
 * How much to trust the URL a builder produced.
 *
 * `driven` is not a third grade of the same scale — it says the URL is not
 * carrying the search at all. The page it opens is just where the form lives,
 * and a driver types the itinerary and the code in, verifying each field against
 * what the form then renders. It is deliberately **not** counted among the
 * popup's "reverse-engineered and unverified" links: there is no reverse
 * engineering in it, and a driven vendor checks more than a verified deep link
 * does — National's driver refuses the quote outright unless its results page
 * names the account the code belongs to.
 */
export type LinkConfidence = 'verified' | 'best-effort' | 'driven';

export interface DeepLink {
  url: string;
  confidence: LinkConfidence;
}

/** MM/DD/YYYY, used by most US booking forms. */
export function usDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) throw new Error(`expected yyyy-mm-dd, got: ${iso}`);
  return `${m}/${d}/${y}`;
}

function carTrip(trip: Trip): CarTrip {
  if (trip.category !== 'car') throw new Error('expected a car trip');
  return trip;
}

function hotelTrip(trip: Trip): HotelTrip {
  if (trip.category !== 'hotel') throw new Error('expected a hotel trip');
  return trip;
}

/**
 * The IATA code a vendor addresses a branch by, from what the popup collected.
 *
 * Deliberately strict, and deliberately throws. Neither Avis's
 * `pickup_location_code` nor Hertz's `pid` is free text — both matched `TPA`
 * and would have made nothing of "Tampa Airport" — so anything else has to fail
 * here, visibly, as `link-build`. Guessing (taking the first three-letter word,
 * say) turns "New York" into the airport `NEW`, which is the silent
 * wrong-search this whole file has been apologising for.
 *
 * Hertz's own UI emits a branch id rather than an airport — the captured URL
 * said `pid=PHLT11` — but a bare IATA code is accepted and really does select
 * the market: TPA returned 36 vehicles at $31-$133 where PHL returned 31 at
 * $36-$111. That is why this is shared rather than per-vendor.
 */
export function airportCode(location: string): string {
  const trimmed = location.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(trimmed)) {
    throw new Error(`expected a 3-letter airport code, got: ${location}`);
  }
  return trimmed;
}

/**
 * Split an ISO date into the parts a vendor wants as separate parameters.
 *
 * Throws on anything that is not `yyyy-mm-dd`, and that is the entire point.
 * The first version of this destructured `split('-')` and defaulted the pieces
 * to `''` — and since `withParams` drops empty values, a malformed date
 * silently *omitted* `pickup_month` and `pickup_day` rather than failing. Avis
 * answers such a URL with a default-date search: real results page, real
 * prices, quote `ok`, nothing flagged, badged `verified`. That is precisely the
 * silent wrong search this file exists to stop producing, and `usDate` right
 * above chose the throwing shape for the same reason.
 */
export function isoParts(iso: string): { year: string; month: string; day: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`expected yyyy-mm-dd, got: ${iso}`);
  }
  return { year: match[1], month: match[2], day: match[3] };
}

/**
 * Split a time onto a 12-hour clock, and validate it.
 *
 * Named for what it does rather than for Avis: Hertz uses it purely as the
 * validator, since its own timestamp is 24-hour.
 *
 * The whole string is matched, not just the hour. Validating the hour alone and
 * passing the minute through untouched accepted `':30'` as 12:30 AM (`Number('')`
 * is 0) and quietly read `'07:5'` as 07:05 — this repo's own rule that "a guard
 * that refuses only the first position of a digit run refuses nothing" applies
 * verbatim. It also rejects the `HH:MM:SS` an `<input type=time step>` can emit,
 * which would otherwise have been concatenated into a nonsense timestamp.
 *
 * Zero-padding the hour is not a guess: Avis rewrote `pickup_hour=9` to
 * `pickup_hour=09` in the address bar and rendered "Oct 16 | 09:00 AM", so
 * padded is the canonical form and unpadded is merely tolerated.
 */
export function clock12(hhmm: string): {
  hour: string;
  minute: string;
  ampm: string;
  /** The same time on a 24-hour clock, zero-padded. Hertz wants this form. */
  hour24: string;
} {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match?.[1] || !match[2]) throw new Error(`expected hh:mm, got: ${hhmm}`);
  const hour24 = Number(match[1]);
  if (hour24 > 23) throw new Error(`expected hh:mm, got: ${hhmm}`);
  if (Number(match[2]) > 59) throw new Error(`expected hh:mm, got: ${hhmm}`);
  // 00:xx is 12 AM and 12:xx is 12 PM; the modulo alone yields a nonexistent 0.
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    hour: String(hour12).padStart(2, '0'),
    minute: match[2],
    ampm: hour24 < 12 ? 'AM' : 'PM',
    // Returned rather than re-derived by the caller, so the padding that makes
    // `9:00` into `09:00` cannot be skipped by whoever builds a timestamp.
    hour24: String(hour24).padStart(2, '0'),
  };
}

/**
 * Refuse a one-way trip for a vendor whose return-location parameter we do not
 * trust.
 *
 * `return_location_code` was honoured on the first captured replay and then
 * **ignored** on two later ones: a URL asking for LAX to LAX rendered "Los
 * Angeles Intl Airport (LAX) - Philadelphia Intl Airport (PHL)", keeping a
 * return location left over from an earlier session in the same browser
 * profile. The extension's probe tabs share that profile, so this is reachable
 * in normal use.
 *
 * A one-way rental prices nothing like the round trip the user asked for, and
 * the quote would come back `ok` with no tell. Until the parameter is
 * understood, refusing is the honest answer: `link-build` is visible in the
 * popup, a wrong price is not.
 */
function sameCityOnly(vendor: string, pickup: string, dropoff: string): void {
  if (dropoff.trim() && dropoff.trim().toUpperCase() !== pickup.trim().toUpperCase()) {
    throw new Error(`${vendor} one-way trips are not supported: its return location is unreliable`);
  }
}

/**
 * Hertz's `pdate`/`ddate`: a local wall-clock ISO timestamp, zero-padded.
 *
 * Both halves come back through their validators rather than from the trip's
 * raw strings, so a `9:00` that `clock12` accepts cannot still reach the URL as
 * `T9:00:00`.
 */
function hertzStamp(isoDate: string, hhmm: string): string {
  const { year, month, day } = isoParts(isoDate);
  const { hour24, minute } = clock12(hhmm);
  return `${year}-${month}-${day}T${hour24}:${minute}:00`;
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

type Builder = (code: string, trip: Trip) => DeepLink;

/**
 * A vendor whose deep link the site ignores outright.
 *
 * Distinct from `'best-effort'`, which means "this URL may have rotted". These
 * are known never to have worked, so producing a URL at all only manufactures a
 * plausible wrong price.
 */
function unsearchable(
  vendor: string,
  because = 'cannot be searched by URL — its search lives in session state, so it needs its form driven rather than a deep link',
): Builder {
  // Defence in depth, not the primary guard: these vendors are also
  // `searchable: false` in vendors.ts, so `buildCandidates` never proposes them
  // and the popup never offers a chip. This catches a plan that arrives some
  // other way.
  //
  // The reason is the *whole* sentence, not a clause appended to a fixed
  // prefix, because the vendors do not share one and the difference decides
  // what would fix each. Budget and enterprise keep the search in session
  // state, so no query string can express it and no builder for them can ever
  // work. Sixt's URL searches perfectly well and has nowhere to put the code.
  //
  // A fixed "cannot be searched by URL" prefix made that distinction
  // unsayable, and it would now be flatly wrong for Sixt rather than merely
  // unprovable — in the one string a user actually sees, the `link-build`
  // tooltip. (This comment said "Sixt's URL simply reaches the wrong page —
  // one path measured once, and another may work" until 2026-08-12, when
  // another path was measured and the vendor closed on the code instead.)
  //
  // `vendor` is prepended, so a reason must read as its continuation and must
  // not name the vendor again.
  return () => {
    throw new Error(`${vendor} ${because}`);
  };
}

const BUILDERS: Record<VendorId, Builder> = {
  /**
   * Captured from a hand-run search, then proved to replay: changing only the
   * airport moved the page from 31 vehicles at $36-$111 to 36 at $31-$133.
   * Differing inventory *and* prices is the proof — the vehicles step never
   * names the location on screen, so nothing else here could tell a driven
   * search apart from a default one.
   *
   * The old builder was wrong in every part: `/rentacar/reservation/` 302s to
   * the home page, and the code parameter is `CDP`, not `cdpid`.
   *
   * The CDP is separately evidenced, and needs to be: driving the *search* and
   * applying the *discount* are two claims, and for a discount-code racer the
   * second is the load-bearing one. The replayed page carried "Save 10%" on its
   * cards alongside `ownershipType=CORPORATE`.
   *
   * What `verified` does and does not cover here — the flag is a claim about
   * the URL shape, not about every itinerary:
   * - Tested: a US airport, round trip, corporate CDP.
   * - Untested: any non-US market, against a hard-coded `pCountryCode: 'US'`.
   * - Refused rather than guessed: one-way. Hertz's `did` was never exercised
   *   with a different airport, and Avis's equivalent proved unreliable, so
   *   both refuse rather than risk pricing a journey nobody asked for.
   * - `age` is hard-coded because the popup collects no driver age. 25 dodges
   *   the under-25 surcharge, so it can understate the price for a younger
   *   renter.
   */
  hertz: (code, trip) => {
    const t = carTrip(trip);
    sameCityOnly('hertz', t.pickupLocation, t.dropoffLocation);
    // Built from validated parts, not from the raw strings. Interpolating
    // `t.pickupTime` directly passed validation and still emitted
    // `2026-09-04T9:00:00` for a `9:00` input — not valid ISO 8601, and exactly
    // the malformed timestamp the validation is here to prevent. The guard has
    // to feed the value it guarded.
    const pdate = hertzStamp(t.pickupDate, t.pickupTime);
    const ddate = hertzStamp(t.dropoffDate, t.dropoffTime);
    return {
      confidence: 'verified',
      url: withParams('https://www.hertz.com/us/en/book/vehicles', {
        CDP: code,
        pid: airportCode(t.pickupLocation),
        did: airportCode(t.dropoffLocation || t.pickupLocation),
        // Local wall-clock, no zone: exactly what the site's own URL carried.
        pdate,
        ddate,
        // Carried verbatim from the captured URL, as with Avis. ownershipType
        // is the one that reads load-bearing — it says the CDP is a corporate
        // rate rather than a promotion — so none of them are trimmed on a hunch.
        travelType: 'LEISURE',
        ownershipType: 'CORPORATE',
        pCountryCode: 'US',
        age: '25',
      }),
    };
  },

  /**
   * The one builder in this file confirmed against the live site.
   *
   * Captured from a real search run by hand, then proved to *replay* rather
   * than read a session: changing only `pickup_location_code` moved the results
   * page from Philadelphia to "Tampa Intl Airport (TPA)", 24 vehicles, with
   * "Your savings are reflected below" confirming the AWD had applied. That
   * second step is the one that matters — Enterprise's URL looked plausible too
   * and turned out to carry nothing.
   *
   * What `verified` does and does not cover — the flag is a claim about the URL
   * shape, not about every itinerary:
   * - Tested: a US airport, round trip, corporate AWD. An explicit
   *   `awd_number` also beats one left in the browser session, which matters
   *   because the probe tabs share the user's profile; without that the whole
   *   race could have been priced with one sticky code.
   * - Untested: any non-US market, against hard-coded `pickup_location_region:
   *   'NAM'`, `residency_value: 'US'`, `country`, `locale`.
   * - Refused rather than guessed: one-way, because `return_location_code` was
   *   honoured on one replay and ignored on two others (see `sameCityOnly`).
   * - `age` is hard-coded, because the popup collects no driver age. 25 avoids
   *   the under-25 surcharge, so it is the optimistic end of the range and can
   *   understate the real price for a younger renter.
   *
   * Hour padding is *not* on that list any more: Avis rewrote `pickup_hour=9`
   * to `09` and rendered "09:00 AM", so the padded form is its own canonical
   * one. Single-digit day/month padding is still untested — the captured search
   * was 16/10 — but comes straight from the ISO date, which `isoParts` now
   * refuses to accept in any other shape.
   */
  avis: (code, trip) => {
    const t = carTrip(trip);
    sameCityOnly('avis', t.pickupLocation, t.dropoffLocation);
    const pickup = clock12(t.pickupTime);
    const dropoff = clock12(t.dropoffTime);
    const pickDate = isoParts(t.pickupDate);
    const dropDate = isoParts(t.dropoffDate);
    return {
      confidence: 'verified',
      url: withParams('https://www.avis.com/en/reservation/vehicle-availability', {
        awd_number: code,
        pickup_location_code: airportCode(t.pickupLocation),
        return_location_code: airportCode(t.dropoffLocation || t.pickupLocation),
        pickup_year: pickDate.year,
        pickup_month: pickDate.month,
        pickup_day: pickDate.day,
        pickup_hour: pickup.hour,
        pickup_minute: pickup.minute,
        pickup_am_pm: pickup.ampm,
        return_year: dropDate.year,
        return_month: dropDate.month,
        return_day: dropDate.day,
        return_hour: dropoff.hour,
        return_minute: dropoff.minute,
        return_am_pm: dropoff.ampm,
        // Carried verbatim from the captured URL. Some are probably optional,
        // but which ones is unknown, and trimming by guesswork is how the rest
        // of this file got into the state it is in.
        pickup_suggestion_type_code: 'AIRPORT',
        dropoff_suggestion_type_code: 'AIRPORT',
        pickup_location_region: 'NAM',
        residency_value: 'US',
        age: '25',
        country: 'us',
        locale: 'en-US',
        brand: 'avis',
      }),
    };
  },

  /**
   * Budget and Enterprise refuse rather than build.
   *
   * All three keep the search in session state, and this is not a suspicion:
   * a hand-run Enterprise search ends on `/en/reserve.html#car_select` and a
   * hand-run Budget one on `/en/reservation#/vehicles` — neither carries a
   * query string, and Enterprise's URL pasted into a fresh incognito window
   * shows no cars at all. `buildDeepLink` *can* still produce a URL for them,
   * carrying the code and every trip field; the site acts on none of it.
   *
   * Returning that URL is the worst of the options. The landing page answers
   * with a marketing "from $19/day", the probe reads it as a real price, and
   * nothing downstream can tell the difference: `compare.ts` never looks at
   * `confidence`, so the number is ranked head-to-head against Avis and Hertz
   * and wins on being cheapest. `landedElsewhere` cannot save it either —
   * `finalPath` is truncated at the first `#`, so `reservation.html#car_select`
   * compares equal to the path we asked for and is never flagged.
   *
   * Sixt throws too, and its own entry below says why — a different reason, and
   * deliberately not this one: its URL reaches the wrong page rather than
   * carrying a search the site ignores. National left this group in #55; it
   * builds the page its form lives on and is driven.
   *
   * So they throw, and surface as `link-build` against the code that could not
   * be searched. That is the same trade this file makes for a malformed date
   * and a one-way trip: a visible failure beats an invisible wrong price. They
   * come back when something drives their forms.
   *
   * **Enterprise left this group on 2026-08-12**, the same way National did and
   * for the same reason: it has a driver now. Its URL still carries nothing —
   * `?cid=` does not even pre-fill the account field — so this is not a deep
   * link and is not graded as one. `'driven'` says the search is not in the URL
   * at all.
   *
   * Only Budget is left here, and only because nothing drives its form yet.
   */
  budget: unsearchable('budget'),

  /**
   * Enterprise's reservation page, which carries no itinerary.
   *
   * Same shape as `national` below: the URL is where the form lives, and
   * `drivers/enterprise.ts` fills it in. Written out rather than read from
   * `enterpriseDriver.startUrl()` because that module imports this one for
   * `airportCode`, `clock12` and `isoParts`, so reaching back the other way is
   * a cycle. `tests/deeplinks.test.ts` asserts the two agree.
   */
  enterprise: () => ({
    confidence: 'driven',
    url: 'https://www.enterprise.com/en/reserve.html',
  }),

  /**
   * National is the exception, because it has a driver.
   *
   * The URL carries no itinerary and no code — it is only where the form lives,
   * and `drivers/national.ts` fills the form in. That is why it is `driven`
   * rather than graded on the reverse-engineering scale the other builders use.
   *
   * Written out rather than read from `nationalDriver.startUrl()` because that
   * module imports this one for `clock12` and `isoParts`, so reaching back the
   * other way is a cycle. `tests/deeplinks.test.ts` asserts the two agree, which
   * is the same trick `tests/manifest.test.ts` uses to pin the manifest against
   * `vendors.ts`.
   */
  national: () => ({
    confidence: 'driven',
    url: 'https://www.nationalcar.com/en/home.html',
  }),

  /**
   * Sixt refuses rather than building, and **not** because its URL cannot
   * search. That version of this comment was true of `/php/reservation`, a
   * legacy path that 302s to the site root, and it closed by inviting the next
   * reader to capture a working URL. Someone did, on 2026-08-12. It did not
   * help, and the invitation is what cost the afternoon — hence this rewrite.
   *
   * The live funnel is `https://www.sixt.com/betafunnel/#/offerlist`, and it
   * replays. Enough to reach real prices:
   *
   *   zen_pu_branch_id / zen_do_branch_id   BRANCH:<id>
   *   zen_pu_time / zen_do_time             YYYY-MM-DDTHH:MM
   *   zen_vehicle_type=car
   *   zen_pickup_country_code=US, zen_point_of_sale=US
   *
   * `zen_session_id`, `zen_offer_matrix_id` and the `zen_pu_location` UUID are
   * all optional — the app mints or derives them. Proved harder than Avis's
   * replay: loading Miami's `BRANCH:4` under a deliberately contradictory
   * `zen_pu_title=Tampa Int Airport` returned Miami's inventory and rewrote the
   * title back to Miami. The branch id searches; the title is decoration.
   *
   * **The blocker is the code, not the URL.** No discount or corporate-code
   * field exists anywhere in that funnel — not the home form, not the results
   * page, not the booking-option step — and Sixt's corporate vocabulary is all
   * account-shaped (`corporateAuthClient`, `CorporateUser`, `CorporateProfile`,
   * `CorporateInvitations`), with "Register my business" and login the only
   * corporate entry points on the site. A code like `19145742` appears to need
   * an authenticated business account. That kills the driver route too: a
   * driver needs a field, and there is none to drive.
   *
   * Two further findings, each of which would have to be solved even if the
   * code problem were:
   *
   * - A branch id is neither an IATA code nor derivable from one (TPA is
   *   `BRANCH:41217`, MIA is `BRANCH:4`), and not every airport has one. LAX
   *   and MIA autocomplete only as *areas* (`GOOGLE_PLACES:…`), which route to
   *   `#/nearbybranches` — a location picker carrying no prices at all. A
   *   builder taking this file's `Trip` would need a branch table that does not
   *   exist.
   * - Every parameter lives in the **fragment**, and `finalPath` truncates at
   *   the first `#`. So `landedElsewhere` is blind to every Sixt URL alike:
   *   they all read as `/betafunnel/`. Same shape as the Enterprise
   *   `reservation.html#car_select` case described in CLAUDE.md.
   *
   * The one thing that would reopen this is credentials for a Sixt business
   * account — not another URL. Recon was foreground-tab, so it establishes URL
   * shape rather than what the probe would see, and "no field exists" is a
   * strong negative from four places rather than proof that no private
   * corporate parameter exists anywhere. Judged not worth pursuing on
   * 2026-08-12: obtaining a corporate login for Deloitte or Palantir is far
   * more effort than the vendor is worth. **Sixt is closed, not paused.**
   *
   * *"Then race it with no code at all — its retail rate might win anyway."*
   * A natural idea, raised and declined the same day, and it fails on the
   * branch id rather than on the code: without a lookup table this builder
   * still cannot turn `trip.pickUpLocation` into a `BRANCH:<id>`, and for an
   * airport like LAX no single branch exists to look up. The table would have
   * to be captured by hand, one airport at a time, and would go silently wrong
   * whenever Sixt renumbered — a standing maintenance cost for a retail rate
   * nothing suggests beats the corporate codes we already race. It would also
   * need a codeless candidate, which `buildCandidates` and the popup's
   * per-code rows have no concept of today.
   */
  sixt: unsearchable(
    'sixt',
    // Still not "cannot be searched by URL" — the prefix budget and enterprise
    // carry — but no longer for the old reason. Sixt's URL *does* search; what
    // it cannot do is carry a code. This string reaches the user as the
    // `link-build` tooltip, so it names the actual obstacle: someone reading it
    // should not go hunting for a better URL, which is what the previous
    // wording sent one person off to do.
    'has no field for a corporate code — its search URL works, but corporate rates there appear to need a business account login',
  ),

  hilton: (code, trip) => {
    const t = hotelTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.hilton.com/en/search/', {
        query: t.destination,
        arrivalDate: t.checkIn,
        departureDate: t.checkOut,
        numAdults: String(t.adults),
        numRooms: String(t.rooms),
        corporateCode: code,
      }),
    };
  },

  marriott: (code, trip) => {
    const t = hotelTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.marriott.com/search/findHotels.mi', {
        'destinationAddress.destination': t.destination,
        fromDate: usDate(t.checkIn),
        toDate: usDate(t.checkOut),
        numAdultsPerRoom: String(t.adults),
        roomCount: String(t.rooms),
        corporateCode: code,
      }),
    };
  },

  hyatt: (code, trip) => {
    const t = hotelTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.hyatt.com/shop/', {
        location: t.destination,
        checkinDate: t.checkIn,
        checkoutDate: t.checkOut,
        adults: String(t.adults),
        rooms: String(t.rooms),
        corp_id: code,
      }),
    };
  },

  starwood: () => {
    // Starwood was folded into Marriott in 2018 and has no bookable site.
    throw new Error('starwood codes are reference-only and cannot be searched');
  },
};

export function buildDeepLink(vendor: VendorId, code: string, trip: Trip): DeepLink {
  return BUILDERS[vendor](code, trip);
}
