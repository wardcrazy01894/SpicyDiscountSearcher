import { describe, expect, it } from 'vitest';

import { buildDeepLink, usDate } from '../src/core/deeplinks.js';
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

describe('buildDeepLink', () => {
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
