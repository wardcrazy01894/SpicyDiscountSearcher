import { describe, expect, it } from 'vitest';

import { checkTrip, renderedCodes } from '../src/core/verify-trip.js';
import type { CarTrip, HotelTrip } from '../src/core/types.js';

const ROUND_TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-10-16',
  pickupTime: '12:00',
  dropoffDate: '2026-10-18',
  dropoffTime: '12:00',
};

/** The exact strings observed on Avis, so the fixtures are not invented. */
const CONTAMINATED =
  'EN Sign in or Join Tampa Intl Airport (TPA) - Philadelphia Intl Airport (PHL) Oct 16 | 12:00 PM';
const CLEARED =
  'EN Sign in or Join Tampa Intl Airport (TPA) - Select drop-off location Oct 16 | 12:00 PM';

describe('renderedCodes', () => {
  it('reads parenthesised airport codes out of the summary', () => {
    expect(renderedCodes(CONTAMINATED)).toEqual(['TPA', 'PHL']);
  });

  it('ignores bare three-letter words', () => {
    // Prose is full of them. A false positive here throws away a good quote,
    // which is worse than the check not firing.
    expect(renderedCodes('All SUV USD Vehicle Types Seats Transmission')).toEqual([]);
  });

  it('does not read the whole page', () => {
    // A code deep in a footer or a "popular destinations" list is not the trip
    // summary, and treating it as one would reject every page that has one.
    expect(renderedCodes(`${CLEARED}${' '.repeat(500)}Orlando Intl Airport (MCO)`)).toEqual([
      'TPA',
    ]);
  });
});

describe('checkTrip', () => {
  it('catches the stale location Avis was rendering', () => {
    // The measured failure: a URL asking TPA to TPA rendered PHL as the return,
    // because Avis's persisted widget outranked the query string. Real page,
    // real prices, different rental.
    const { unexpected } = checkTrip(ROUND_TRIP, CONTAMINATED);
    expect(unexpected).toBe('PHL');
  });

  it('accepts an unstated drop-off', () => {
    // What the page shows once the stale store is cleared. Fewer codes than
    // asked for is not a mismatch — the drop-off is simply unstated, and this
    // is the correct round trip.
    expect(checkTrip(ROUND_TRIP, CLEARED).unexpected).toBeNull();
  });

  it('accepts the requested drop-off spelled out', () => {
    expect(
      checkTrip(ROUND_TRIP, 'Tampa Intl Airport (TPA) - Tampa Intl Airport (TPA)').unexpected,
    ).toBeNull();
  });

  it('keeps what it saw even when it passes', () => {
    // The codes ride on the report either way, so a quote that looked fine can
    // still be argued with afterwards.
    expect(checkTrip(ROUND_TRIP, CLEARED).rendered).toEqual(['TPA']);
  });

  it('says nothing about hotels', () => {
    // No airports, and a room search has no equivalent summary to read.
    const hotel: HotelTrip = {
      category: 'hotel',
      destination: 'St. Petersburg, FL',
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
      adults: 2,
      rooms: 1,
    };
    expect(checkTrip(hotel, CONTAMINATED).unexpected).toBeNull();
  });
});
