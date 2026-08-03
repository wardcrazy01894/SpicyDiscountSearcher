import { describe, expect, it } from 'vitest';

import { airportCode, avisClock, buildDeepLink, isoParts, usDate } from '../src/core/deeplinks.js';
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

describe('avisClock', () => {
  it('maps midnight and noon onto a 12-hour clock', () => {
    // The `% 12 === 0 ? 12 : …` branch was reachable by no test at all, so
    // replacing it with a bare `% 12` kept the suite green while sending a noon
    // pickup as hour 00 PM and midnight as 00 AM.
    expect(avisClock('00:00')).toEqual({ hour: '12', minute: '00', ampm: 'AM' });
    expect(avisClock('12:00')).toEqual({ hour: '12', minute: '00', ampm: 'PM' });
    expect(avisClock('12:59')).toEqual({ hour: '12', minute: '59', ampm: 'PM' });
    expect(avisClock('23:59')).toEqual({ hour: '11', minute: '59', ampm: 'PM' });
  });

  it('zero-pads the hour, which is the form Avis itself uses', () => {
    // Not an assumption: Avis rewrote `pickup_hour=9` to `09` in the address
    // bar and rendered "09:00 AM".
    expect(avisClock('09:30')).toMatchObject({ hour: '09', ampm: 'AM' });
  });

  it('rejects a time that is not exactly hh:mm', () => {
    // Validating the hour and passing the minute through read ':30' as 12:30 AM
    // (Number('') is 0) and '07:5' as 07:05 — a time nobody asked for, sent
    // without complaint.
    for (const bad of [':30', '07:5', '0x10:00', '24:00', '10:60', '10:00:00', '', 'ten']) {
      expect(() => avisClock(bad), bad).toThrow(/hh:mm/);
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
    const parsed = new URL(buildDeepLink('budget', 'X915990', CAR).url);
    expect(parsed.searchParams.get('returnLocation')).toBe('TPA');
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

  it('builds a valid https URL for every searchable vendor', () => {
    for (const vendor of searchableVendors()) {
      const trip = vendor.category === 'car' ? CAR : HOTEL;
      const { url } = buildDeepLink(vendor.id, 'TESTCODE', trip);
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe(vendor.host);
      expect(url).toContain('TESTCODE');
    }
  });

  it('rejects a trip of the wrong category', () => {
    expect(() => buildDeepLink('hertz', 'X', HOTEL)).toThrow(/car trip/);
    expect(() => buildDeepLink('hilton', 'X', CAR)).toThrow(/hotel trip/);
  });
});
