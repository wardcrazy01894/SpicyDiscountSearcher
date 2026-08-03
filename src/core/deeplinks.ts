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

/** Avis splits a time into a 12-hour clock across three query parameters. */
export function avisClock(hhmm: string): { hour: string; minute: string; ampm: string } {
  const [h, m] = hhmm.split(':');
  if (h === undefined || m === undefined) throw new Error(`expected hh:mm, got: ${hhmm}`);
  const hour24 = Number(h);
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) {
    throw new Error(`expected hh:mm, got: ${hhmm}`);
  }
  // 00:xx is 12 AM and 12:xx is 12 PM; the modulo alone yields a nonexistent 0.
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    hour: String(hour12).padStart(2, '0'),
    minute: m.padStart(2, '0'),
    ampm: hour24 < 12 ? 'AM' : 'PM',
  };
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
   * `age` is hard-coded for the same reason as Avis's — the popup collects no
   * driver age — with the same caveat that 25 dodges the under-25 surcharge and
   * so can understate the price for a younger renter.
   */
  hertz: (code, trip) => {
    const t = carTrip(trip);
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
   * Two things here are still assumptions, and are called out rather than
   * hidden:
   * - `age` is hard-coded, because the popup collects no driver age. 25 avoids
   *   the under-25 surcharge, so it is the optimistic end of the range and can
   *   understate the real price for a younger renter.
   * - Single-digit days and months go out zero-padded, straight from the ISO
   *   date. The captured search was 16/10, so padding was never exercised.
   */
  avis: (code, trip) => {
    const t = carTrip(trip);
    const pickup = avisClock(t.pickupTime);
    const dropoff = avisClock(t.dropoffTime);
    const [pickYear, pickMonth, pickDay] = t.pickupDate.split('-');
    const [dropYear, dropMonth, dropDay] = t.dropoffDate.split('-');
    return {
      confidence: 'verified',
      url: withParams('https://www.avis.com/en/reservation/vehicle-availability', {
        awd_number: code,
        pickup_location_code: airportCode(t.pickupLocation),
        return_location_code: airportCode(t.dropoffLocation || t.pickupLocation),
        pickup_year: pickYear ?? '',
        pickup_month: pickMonth ?? '',
        pickup_day: pickDay ?? '',
        pickup_hour: pickup.hour,
        pickup_minute: pickup.minute,
        pickup_am_pm: pickup.ampm,
        return_year: dropYear ?? '',
        return_month: dropMonth ?? '',
        return_day: dropDay ?? '',
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
