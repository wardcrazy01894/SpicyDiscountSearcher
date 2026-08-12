import { describe, expect, it } from 'vitest';

import { airportCode, buildDeepLink, clock12, isoParts, usDate } from '../src/core/deeplinks.js';
import type { CarTrip, HotelTrip } from '../src/core/types.js';
import { searchableVendors } from '../src/core/vendors.js';

const CAR: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '10:00',
  dropoffDate: '2026-09-08',
  dropoffTime: '16:30',
};

const HOTEL: HotelTrip = {
  category: 'hotel',
  destination: 'St. Petersburg, FL',
  checkIn: '2026-09-04',
  checkOut: '2026-09-08',
  adults: 2,
  rooms: 1,
};

describe('usDate', () => {
  it('reformats an ISO date for US booking forms', () => {
    expect(usDate('2026-09-04')).toBe('09/04/2026');
  });

  it('rejects anything that is not yyyy-mm-dd', () => {
    expect(() => usDate('09/04/2026')).toThrow();
  });
});

describe('clock12', () => {
  it('maps midnight and noon onto a 12-hour clock', () => {
    // The `% 12 === 0 ? 12 : …` branch was reachable by no test at all, so
    // replacing it with a bare `% 12` kept the suite green while sending a noon
    // pickup as hour 00 PM and midnight as 00 AM.
    expect(clock12('00:00')).toMatchObject({ hour: '12', minute: '00', ampm: 'AM' });
    expect(clock12('12:00')).toMatchObject({ hour: '12', minute: '00', ampm: 'PM' });
    expect(clock12('12:59')).toMatchObject({ hour: '12', minute: '59', ampm: 'PM' });
    expect(clock12('23:59')).toMatchObject({ hour: '11', minute: '59', ampm: 'PM' });
  });

  it('zero-pads the hour, which is the form Avis itself uses', () => {
    // Not an assumption: Avis rewrote `pickup_hour=9` to `09` in the address
    // bar and rendered "09:00 AM".
    expect(clock12('09:30')).toMatchObject({ hour: '09', ampm: 'AM' });
  });

  it('rejects a time that is not exactly hh:mm', () => {
    // Validating the hour and passing the minute through read ':30' as 12:30 AM
    // (Number('') is 0) and '07:5' as 07:05 — a time nobody asked for, sent
    // without complaint.
    for (const bad of [':30', '07:5', '0x10:00', '24:00', '10:60', '10:00:00', '', 'ten']) {
      expect(() => clock12(bad), bad).toThrow(/hh:mm/);
    }
  });
});

describe('isoParts', () => {
  it('rejects a date that is not yyyy-mm-dd', () => {
    // The reason this throws rather than defaulting: withParams drops empty
    // values, so a malformed date silently omitted pickup_month and pickup_day
    // and Avis answered with a *default-date* search — real page, real prices,
    // quote `ok`, nothing flagged.
    for (const bad of ['09/04/2026', '2026-9-4', '', '2026-09', 'yesterday']) {
      expect(() => isoParts(bad), bad).toThrow(/yyyy-mm-dd/);
    }
    expect(isoParts('2026-09-04')).toEqual({ year: '2026', month: '09', day: '04' });
  });
});

describe('airportCode', () => {
  it('accepts a code in any case, with surrounding space', () => {
    expect(airportCode(' tpa ')).toBe('TPA');
  });

  it('refuses to guess a code out of free text', () => {
    // Taking the first three-letter word would read "New York" as the airport
    // NEW — a real airport code, for an airport nobody asked for.
    for (const bad of ['New York', 'Tampa Airport', 'TP', 'TPAX', '']) {
      expect(() => airportCode(bad), bad).toThrow(/3-letter airport code/);
    }
  });
});

describe('buildDeepLink', () => {
  it('refuses a malformed date rather than dropping it from the URL', () => {
    for (const vendor of ['avis', 'hertz'] as const) {
      expect(() => buildDeepLink(vendor, 'X1', { ...CAR, pickupDate: '09/04/2026' })).toThrow(
        /yyyy-mm-dd/,
      );
    }
  });

  it('refuses a one-way trip while the return location is unreliable', () => {
    // avis honoured return_location_code on one replay and ignored it on two
    // others, rendering LAX -> PHL for a URL asking LAX -> LAX. A one-way
    // rental prices nothing like the round trip the user asked for.
    for (const vendor of ['avis', 'hertz'] as const) {
      expect(() => buildDeepLink(vendor, 'X1', { ...CAR, dropoffLocation: 'MCO' })).toThrow(
        /one-way/,
      );
    }
    // Same airport spelled differently is not a one-way trip.
    expect(() => buildDeepLink('avis', 'X1', { ...CAR, dropoffLocation: ' tpa ' })).not.toThrow();
  });

  it('puts the Hertz CDP on the vehicles URL', () => {
    // Shape read off a hand-run search and then replayed with a changed
    // airport. The previous assertion passed against `/rentacar/reservation/`
    // and `cdpid`, neither of which exists: that path 302s to the home page.
    const link = buildDeepLink('hertz', '1409996', CAR);
    const parsed = new URL(link.url);
    expect(parsed.host).toBe('www.hertz.com');
    expect(parsed.pathname).toBe('/us/en/book/vehicles');
    expect(parsed.searchParams.get('CDP')).toBe('1409996');
    expect(parsed.searchParams.get('pid')).toBe('TPA');
    expect(parsed.searchParams.get('did')).toBe('TPA');
    expect(parsed.searchParams.get('pdate')).toBe('2026-09-04T10:00:00');
    expect(parsed.searchParams.get('ddate')).toBe('2026-09-08T16:30:00');
    expect(parsed.searchParams.get('ownershipType')).toBe('CORPORATE');
    expect(link.confidence).toBe('verified');
  });

  it('refuses a Hertz location that is not an airport code', () => {
    expect(() =>
      buildDeepLink('hertz', '1409996', { ...CAR, pickupLocation: 'Tampa Airport' }),
    ).toThrow(/3-letter airport code/);
  });

  it('carries the Avis AWD on the availability URL', () => {
    // Every value here was read off a search run by hand on avis.com and then
    // replayed with a changed airport, so this test pins a shape that is known
    // to work rather than one that looked plausible.
    const link = buildDeepLink('avis', 'A120590', CAR);
    const parsed = new URL(link.url);
    expect(parsed.host).toBe('www.avis.com');
    expect(parsed.pathname).toBe('/en/reservation/vehicle-availability');
    expect(parsed.searchParams.get('awd_number')).toBe('A120590');
    expect(parsed.searchParams.get('pickup_location_code')).toBe('TPA');
    expect(parsed.searchParams.get('return_location_code')).toBe('TPA');
    expect(parsed.searchParams.get('pickup_year')).toBe('2026');
    expect(parsed.searchParams.get('pickup_month')).toBe('09');
    expect(parsed.searchParams.get('pickup_day')).toBe('04');
    expect(link.confidence).toBe('verified');
  });

  it('zero-pads a single-digit hour into the Hertz timestamp', () => {
    // The round-2 fix — building pdate from clock12's validated parts rather
    // than the raw trip string — was unpinned: both reverting it and dropping
    // the padStart left the whole suite green, because every other case here
    // uses a two-digit hour. `2026-09-04T9:00:00` is not valid ISO 8601 and is
    // the malformed timestamp the validation exists to prevent.
    const parsed = new URL(buildDeepLink('hertz', 'X1', { ...CAR, pickupTime: '9:00' }).url);
    expect(parsed.searchParams.get('pdate')).toBe('2026-09-04T09:00:00');
    expect(clock12('9:00')).toMatchObject({ hour24: '09', hour: '09', ampm: 'AM' });
    expect(clock12('00:30')).toMatchObject({ hour24: '00', hour: '12', ampm: 'AM' });
    expect(clock12('23:59')).toMatchObject({ hour24: '23', hour: '11', ampm: 'PM' });
  });

  it('splits Avis times onto a 12-hour clock', () => {
    const parsed = new URL(buildDeepLink('avis', 'A120590', CAR).url);
    // CAR drops off at 16:30.
    expect(parsed.searchParams.get('return_hour')).toBe('04');
    expect(parsed.searchParams.get('return_minute')).toBe('30');
    expect(parsed.searchParams.get('return_am_pm')).toBe('PM');
    // ...and picks up at 10:00.
    expect(parsed.searchParams.get('pickup_hour')).toBe('10');
    expect(parsed.searchParams.get('pickup_am_pm')).toBe('AM');
  });

  it('refuses an Avis location that is not an airport code', () => {
    // The failure has to be loud: pickup_location_code is not free text, and a
    // silent bad search is the exact bug this file exists to stop producing.
    expect(() =>
      buildDeepLink('avis', 'A120590', { ...CAR, pickupLocation: 'Tampa Airport' }),
    ).toThrow(/3-letter airport code/);
  });

  it('falls back to the pick-up location when no drop-off is given', () => {
    // CAR leaves dropoffLocation empty. Read off hertz rather than budget,
    // which no longer builds a URL at all.
    expect(new URL(buildDeepLink('hertz', 'X915990', CAR).url).searchParams.get('did')).toBe('TPA');
    expect(
      new URL(buildDeepLink('avis', 'X915990', CAR).url).searchParams.get('return_location_code'),
    ).toBe('TPA');
  });

  it('refuses outright for a vendor that ignores the search URL', () => {
    // Not `best-effort`, which means "may have rotted". These were observed
    // ignoring the query string entirely, so any URL built for them lands on a
    // page whose "from $19/day" is read as a real price and, being cheapest,
    // wins. link-build is visible; that is not.
    //
    // Belt and braces: they are `searchable: false` too, so nothing routes a
    // plan here in the first place. This pins the inner guard on its own.
    for (const vendor of ['budget', 'enterprise'] as const) {
      expect(() => buildDeepLink(vendor, 'X1', CAR), vendor).toThrow(/session state/);
    }
  });

  it('refuses for sixt, naming the code rather than the URL as the obstacle', () => {
    // This assertion used to pin `/302s to the site root/`, back when Sixt's
    // refusal was about a URL that missed its search. That reading was measured
    // wrong on 2026-08-12: `/betafunnel/#/offerlist` searches fine and replays.
    // What Sixt has no room for is the *code*.
    //
    // The distinction is the whole point of pinning the message. Somebody
    // reading "no working search URL" goes hunting for a better URL — which is
    // exactly what happened, and the URL they find does not help. Somebody
    // reading this one knows the obstacle is a business-account login and stops.
    expect(() => buildDeepLink('sixt', 'X1', CAR)).toThrow(/corporate code/);

    // Still not "session state", which is budget and enterprise's reason and
    // would be the wrong diagnosis here — Sixt's query string expresses a
    // search perfectly well.
    expect(() => buildDeepLink('sixt', 'X1', CAR)).not.toThrow(/session state/);
  });

  it('opens the form page for a vendor whose driver does the searching', () => {
    // National left the list above when it got a driver. Its URL is not a deep
    // link and is not graded as one: it carries no itinerary and no code,
    // because `drivers/national.ts` types those into the form and verifies each
    // against what the form renders back.
    const link = buildDeepLink('national', '5666666', CAR);
    expect(link.confidence).toBe('driven');
    const url = new URL(link.url);
    expect(url.host).toBe('www.nationalcar.com');
    expect(url.search).toBe('');
    // The code must not leak into the address bar, where any script on the page
    // could read it — the whole reason the driver payload goes to the content
    // script's isolated world instead.
    expect(link.url).not.toContain('5666666');
  });

  it('carries hotel corporate codes and dates', () => {
    const hilton = new URL(buildDeepLink('hilton', 'N0156333', HOTEL).url);
    expect(hilton.searchParams.get('corporateCode')).toBe('N0156333');
    expect(hilton.searchParams.get('arrivalDate')).toBe('2026-09-04');

    const marriott = new URL(buildDeepLink('marriott', 'ACC', HOTEL).url);
    expect(marriott.searchParams.get('fromDate')).toBe('09/04/2026');
  });

  it('refuses to search reference-only Starwood numbers', () => {
    expect(() => buildDeepLink('starwood', '5747647', HOTEL)).toThrow(/starwood/i);
  });

  it('builds a valid https URL for every vendor that can be searched at all', () => {
    // `searchableVendors()` already excludes the ones whose site ignores the
    // URL — they are `searchable: false` in vendors.ts, so they never reach a
    // plan either. Pinned by count so a vendor silently dropping out of the
    // registry fails here rather than shrinking the loop unnoticed.
    const built = searchableVendors();
    expect(built.filter((v) => v.category === 'car')).toHaveLength(3);
    for (const vendor of built) {
      const trip = vendor.category === 'car' ? CAR : HOTEL;
      const { url, confidence } = buildDeepLink(vendor.id, 'TESTCODE', trip);
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe(vendor.host);
      if (confidence === 'driven') {
        // The opposite requirement, and the stronger one. A driven vendor's URL
        // is only where the form lives; the code goes to the content script's
        // isolated world, not into an address bar every script on the page can
        // read.
        expect(url).not.toContain('TESTCODE');
      } else {
        expect(url).toContain('TESTCODE');
      }
    }
  });

  it('rejects a trip of the wrong category', () => {
    expect(() => buildDeepLink('hertz', 'X', HOTEL)).toThrow(/car trip/);
    expect(() => buildDeepLink('hilton', 'X', CAR)).toThrow(/hotel trip/);
  });
});
