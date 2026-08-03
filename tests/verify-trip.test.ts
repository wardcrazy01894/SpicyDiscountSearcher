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

/**
 * The literal first 400 characters of `document.body.innerText` on Avis's
 * availability page, captured from the live site — newlines and all.
 *
 * Pasted rather than summarised because `SUMMARY_CHARS` is the load-bearing
 * constant here and a hand-trimmed fixture cannot test it: an earlier version
 * of this file used a tidied one-line string, which proved nothing about where
 * the summary actually falls. On the real page it starts at offset 39, well
 * inside the window — and the header carries `(24)`, a parenthesised triplet
 * that is digits rather than letters, which is the kind of thing only a real
 * capture surfaces.
 */
const CLEARED =
  'EN\nSign in or Join\n\nTampa Intl Airport (TPA) - Select drop-off location\n\n' +
  'Oct 16 | 12:00 PM - Oct 18 | 12:00 PM\n\nMake a Reservation\n2\nPick your vehicle\n3\n' +
  'Review & Checkout\nAVAILABLE VEHICLES\n \n(24)\nVehicle Type\n\u200b\nSeats\nTransmission\n' +
  '\u200b\nPrice\nRecommended\n\u200b\nYour savings are reflected below.\nMEMBERS SAVE UP TO 35%\n' +
  'Sign In for the best price or create a FREE account at checkout.\n\nSTART YOUR TRIP SOONER\n\n';

/**
 * The same page in the state that started all this, which differs from the
 * capture above by exactly the drop-off phrase — that substitution is what the
 * stale `booking-widget.store` produced.
 */
const CONTAMINATED = CLEARED.replace('Select drop-off location', 'Philadelphia Intl Airport (PHL)');

describe('renderedCodes', () => {
  it('reads parenthesised airport codes out of the summary', () => {
    expect(renderedCodes(CONTAMINATED)).toEqual(['TPA', 'PHL']);
  });

  it('ignores a parenthesised number, which the real page carries', () => {
    // "(24)" is the vehicle count and sits in the same header.
    expect(renderedCodes(CLEARED)).toEqual(['TPA']);
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

  it('reports what it saw alongside the verdict', () => {
    expect(checkTrip(ROUND_TRIP, CLEARED).rendered).toEqual(['TPA']);
  });

  it('needs an asked-for code present before blaming an unexpected one', () => {
    // `(USD)`, `(EST)`, `(GPS)` are all parenthesised uppercase triplets a
    // booking page can carry. Without the anchor requirement a currency
    // selector above the summary would fail every Avis quote in every run,
    // while the popup announced "the page priced a different trip" about a
    // perfectly correct page. Whole-vendor false positive vs. the narrow hole
    // below, and this is the better trade.
    expect(checkTrip(ROUND_TRIP, 'Prices shown in (USD) — (EST) times').unexpected).toBeNull();
    // The anchor is what makes the real failure reportable: TPA was present
    // alongside the stale PHL.
    expect(checkTrip(ROUND_TRIP, CONTAMINATED).unexpected).toBe('PHL');
  });

  it('is blind when the page replaced both ends, and that is known', () => {
    // No asked-for code survives, so nothing anchors the comparison. Recorded
    // rather than discovered later; the reset script is what makes it unlikely.
    const bothWrong = CLEARED.replace(
      'Tampa Intl Airport (TPA)',
      'Miami Intl Airport (MIA)',
    ).replace('Select drop-off location', 'Orlando Intl Airport (MCO)');
    expect(checkTrip(ROUND_TRIP, bothWrong).unexpected).toBeNull();
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
