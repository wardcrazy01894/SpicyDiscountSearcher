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
 * To fix one: open the vendor site, run a search with the code applied by hand,
 * copy the resulting URL, and update the builder below. `tests/deeplinks.test.ts`
 * pins the shape of each URL so a change is deliberate rather than accidental.
 */

export type LinkConfidence = 'verified' | 'best-effort';

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
 * Avis splits a time into a 12-hour clock across three query parameters.
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
export function avisClock(hhmm: string): { hour: string; minute: string; ampm: string } {
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
  if (dropoff && dropoff.trim().toUpperCase() !== pickup.trim().toUpperCase()) {
    throw new Error(`${vendor} one-way trips are not supported: its return location is unreliable`);
  }
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

type Builder = (code: string, trip: Trip) => DeepLink;

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
    // Validated even though Hertz takes a combined timestamp: this rejects the
    // malformed date and the `HH:MM:SS` that would otherwise be concatenated
    // into a string the site reads as a default search.
    isoParts(t.pickupDate);
    isoParts(t.dropoffDate);
    avisClock(t.pickupTime);
    avisClock(t.dropoffTime);
    return {
      confidence: 'verified',
      url: withParams('https://www.hertz.com/us/en/book/vehicles', {
        CDP: code,
        pid: airportCode(t.pickupLocation),
        did: airportCode(t.dropoffLocation || t.pickupLocation),
        // Local wall-clock, no zone: exactly what the site's own URL carried.
        pdate: `${t.pickupDate}T${t.pickupTime}:00`,
        ddate: `${t.dropoffDate}T${t.dropoffTime}:00`,
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
    const pickup = avisClock(t.pickupTime);
    const dropoff = avisClock(t.dropoffTime);
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

  budget: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.budget.com/en/home', {
        BCD: code,
        pickupLocation: t.pickupLocation,
        returnLocation: t.dropoffLocation || t.pickupLocation,
        from: usDate(t.pickupDate),
        to: usDate(t.dropoffDate),
        fromTime: t.pickupTime,
        toTime: t.dropoffTime,
      }),
    };
  },

  enterprise: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.enterprise.com/en/car-rental/reservation.html', {
        cust: code,
        pickupLocation: t.pickupLocation,
        returnLocation: t.dropoffLocation || t.pickupLocation,
        pickupDate: t.pickupDate,
        returnDate: t.dropoffDate,
        pickupTime: t.pickupTime,
        returnTime: t.dropoffTime,
      }),
    };
  },

  national: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.nationalcar.com/en/car-rental/reservation.html', {
        contractNumber: code,
        pickupLocation: t.pickupLocation,
        returnLocation: t.dropoffLocation || t.pickupLocation,
        pickupDate: t.pickupDate,
        returnDate: t.dropoffDate,
        pickupTime: t.pickupTime,
        returnTime: t.dropoffTime,
      }),
    };
  },

  sixt: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.sixt.com/php/reservation', {
        cc: code,
        pickupStation: t.pickupLocation,
        returnStation: t.dropoffLocation || t.pickupLocation,
        pickupDate: t.pickupDate,
        returnDate: t.dropoffDate,
      }),
    };
  },

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
