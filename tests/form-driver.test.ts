/**
 * @vitest-environment jsdom
 *
 * The shared machinery every form driver is built out of.
 *
 * These four helpers are small enough to look obviously correct and are not:
 * `setNativeValue` exists because the obvious version silently does nothing on
 * a React-controlled input, and `hasToken` exists because the obvious version
 * matches `TPA` inside a word. Both mistakes produce a driver that appears to
 * work and submits the wrong search, so both are pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  DriverError,
  type DriveContext,
  hasToken,
  setNativeValue,
  textOf,
  waitFor,
} from '../src/core/form-driver.js';
import type { CarTrip } from '../src/core/types.js';

const TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '12:00',
  dropoffDate: '2026-09-06',
  dropoffTime: '12:00',
};

/** A context with a clock that only moves when the driver sleeps, so a test
 *  for a forty-second wait finishes instantly and deterministically. */
function makeContext(overrides: Partial<DriveContext> = {}): DriveContext {
  let clock = 0;
  return {
    doc: document,
    trip: TRIP,
    code: 'XZ15J55',
    deadline: 10_000,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('setNativeValue', () => {
  it('sets the value and announces it the way a framework listens for', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));

    setNativeValue(input, 'TPA');

    expect(input.value).toBe('TPA');
    // Both, and in this order. A page listening only for `change` and a page
    // listening only for `input` are both real, and Enterprise's autocomplete
    // opens on the latter.
    expect(seen).toEqual(['input', 'change']);
    input.remove();
  });

  it('drives a select as well as an input', () => {
    const select = document.createElement('select');
    for (const value of ['10:00', '12:00']) {
      const option = document.createElement('option');
      option.value = value;
      select.append(option);
    }
    document.body.append(select);

    setNativeValue(select, '12:00');

    expect(select.value).toBe('12:00');
    select.remove();
  });
});

describe('hasToken', () => {
  it('matches a whole word', () => {
    expect(hasToken('Tampa International Airport TPA Tampa, FL', 'TPA')).toBe(true);
    expect(hasToken('(TPA)', 'TPA')).toBe(true);
  });

  it('does not match inside a longer word', () => {
    // The `AUD` inside `Audi` mistake, arriving at a different door: a bare
    // substring test would pick a Tampa suggestion for a search for `PAT`.
    expect(hasToken('Autopark', 'TOP')).toBe(false);
    expect(hasToken('TPAX', 'TPA')).toBe(false);
    expect(hasToken('XTPA', 'TPA')).toBe(false);
  });

  it('refuses an empty token rather than matching everything', () => {
    expect(hasToken('anything at all', '')).toBe(false);
  });
});

describe('textOf', () => {
  it('collapses whitespace so markup indentation does not defeat a comparison', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span>Tampa  International</span>\n   <span>Airport</span>';
    expect(textOf(el)).toBe('Tampa International Airport');
  });

  it('is empty rather than throwing for a missing element', () => {
    expect(textOf(null)).toBe('');
  });

  it('falls back to textContent when innerText is an empty string', () => {
    // The bug that cost a day, and the reason nothing caught it. `innerText` is
    // defined in terms of rendered layout, and a probe tab lives in a minimised
    // window that has none — measured on National, every suggestion button
    // returned `innerText === ""` while `textContent` held the airport name.
    // Written with `??` this returned '', so the driver matched none of
    // seventeen good options and reported that the autocomplete never answered.
    //
    // jsdom leaves `innerText` undefined, so `??` reaches `textContent` here and
    // the old code passed. Defining it explicitly is what makes this test model
    // a browser rather than a DOM shim.
    const el = document.createElement('button');
    el.textContent = 'Philadelphia International Airport (PHL)';
    Object.defineProperty(el, 'innerText', { value: '', configurable: true });

    expect(textOf(el)).toBe('Philadelphia International Airport (PHL)');
    expect(hasToken(textOf(el), 'PHL')).toBe(true);
  });

  it('still prefers innerText when the browser has something to say', () => {
    // Not a blanket switch to textContent: `innerText` collapses a rendered
    // summary to one line, which `verify-trip.ts` depends on, and it omits text
    // the page is hiding.
    const el = document.createElement('div');
    el.textContent = 'hidden and visible';
    Object.defineProperty(el, 'innerText', { value: 'visible', configurable: true });
    expect(textOf(el)).toBe('visible');
  });
});

describe('waitFor', () => {
  it('returns as soon as the page satisfies the condition', async () => {
    let calls = 0;
    const value = await waitFor(makeContext(), 'a thing', () => (++calls >= 3 ? 'ready' : null));
    expect(value).toBe('ready');
    expect(calls).toBe(3);
  });

  it('fails with the code it was given, naming what it waited for', async () => {
    const error = await waitFor(makeContext(), 'the results page', () => null, 'form-submit').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DriverError);
    expect((error as DriverError).failure).toBe('form-submit');
    // The description is the whole diagnostic value — "could not fill the search
    // form" alone would not say which piece of somebody else's markup moved.
    expect((error as DriverError).message).toContain('the results page');
  });

  it('defaults to form-fill, the failure that happens before pricing', async () => {
    const error = await waitFor(makeContext(), 'a field', () => null).catch((e: unknown) => e);
    expect((error as DriverError).failure).toBe('form-fill');
  });

  it('treats false as not-yet-ready rather than as a value', async () => {
    // `read` returning a boolean is the natural shape for "is the hash set
    // yet", and a truthiness bug here would report success on the first poll.
    let ready = false;
    const context = makeContext();
    const promise = waitFor(context, 'the hash', () => ready || null);
    ready = true;
    await expect(promise).resolves.toBe(true);
  });
});
