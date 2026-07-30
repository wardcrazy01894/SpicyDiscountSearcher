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
  it('puts the Hertz CDP on the reservation URL', () => {
    const { url } = buildDeepLink('hertz', '1409996', CAR);
    const parsed = new URL(url);
    expect(parsed.host).toBe('www.hertz.com');
    expect(parsed.searchParams.get('cdpid')).toBe('1409996');
    expect(parsed.searchParams.get('pickupDate')).toBe('09/04/2026');
  });

  it('carries the Avis AWD', () => {
    expect(new URL(buildDeepLink('avis', 'A120590', CAR).url).searchParams.get('AWD')).toBe(
      'A120590',
    );
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
