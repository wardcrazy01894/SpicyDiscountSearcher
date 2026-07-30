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

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

type Builder = (code: string, trip: Trip) => DeepLink;

const BUILDERS: Record<VendorId, Builder> = {
  hertz: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.hertz.com/rentacar/reservation/', {
        cdpid: code,
        pickupLocation: t.pickupLocation,
        returnLocation: t.dropoffLocation || t.pickupLocation,
        pickupDate: usDate(t.pickupDate),
        pickupTime: t.pickupTime,
        returnDate: usDate(t.dropoffDate),
        returnTime: t.dropoffTime,
      }),
    };
  },

  avis: (code, trip) => {
    const t = carTrip(trip);
    return {
      confidence: 'best-effort',
      url: withParams('https://www.avis.com/en/home', {
        AWD: code,
        pickupLocation: t.pickupLocation,
        returnLocation: t.dropoffLocation || t.pickupLocation,
        from: usDate(t.pickupDate),
        to: usDate(t.dropoffDate),
        fromTime: t.pickupTime,
        toTime: t.dropoffTime,
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
