/**
 * @vitest-environment jsdom
 *
 * The content script, which had no tests at all.
 *
 * It is the sole producer of every `Offer` the ranking consumes, so its
 * decisions — when a page has settled, what to do with a partial read, whether
 * to stay inert — set the input to everything downstream. Changing
 * `STABLE_REPEATS_REQUIRED` to 0 would ship prices scraped from a half-rendered
 * page with the rest of the suite green.
 *
 * Driven the way Chrome drives it: install a fake `chrome`, import the module,
 * and answer its `PROBE_READY` with an assignment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProbeAssignment } from '../src/core/messages.js';
import type { CarTrip } from '../src/core/types.js';

/**
 * The assignment shape, so the fixture below can be built with `satisfies` and
 * the compiler drags it forward with the protocol.
 *
 * The variable stays `unknown` because other tests assign `PROBE_IDLE` and a
 * deliberately malformed reply to it; the `satisfies` on the literal is what
 * does the work.
 *
 * It went stale silently when `PROBE_START` grew `trip` and `code`: an untyped
 * literal still satisfied the fake, so the day a driver reads `assignment.trip`
 * every test here would have run it against `undefined` and passed.
 */
type StartAssignment = Extract<ProbeAssignment, { type: 'PROBE_START' }>;

const FIXTURE_TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '10:00',
  dropoffDate: '2026-09-08',
  dropoffTime: '10:00',
};

/** src/content/probe.ts POLL_INTERVAL_MS. */
const POLL = 1_500;

/** The assignment's own timeoutMs, so the poll-count arithmetic below can
 *  derive from it rather than restating a number. */
const TIMEOUT_MS = 40_000;

interface Sent {
  type: string;
  failure?: string;
  message?: string;
  offers?: Array<{ amount: number }>;
  report?: { finalPath: string; title: string; offerCount: number; path: string };
}

let sent: Sent[];
let assignment: unknown;
/** Make the next N sendMessage calls reject, as a restarting worker does. */
let failNext: number;

function installChrome(): void {
  sent = [];
  failNext = 0;
  assignment = {
    type: 'PROBE_START',
    vendor: 'hertz',
    quoteId: 'hertz:H1',
    timeoutMs: TIMEOUT_MS,
    trip: FIXTURE_TRIP,
    code: 'H1',
  } satisfies StartAssignment;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: (message: Sent) => {
        if (message.type === 'PROBE_READY') return Promise.resolve(assignment);
        if (failNext > 0) {
          failNext -= 1;
          return Promise.reject(new Error('Could not establish connection.'));
        }
        sent.push(message);
        return Promise.resolve(undefined);
      },
    },
  };
}

/** Import the probe and let its poll loop run for `ms` of fake time. */
async function run(ms: number): Promise<void> {
  await import('../src/content/probe.js');
  await vi.advanceTimersByTimeAsync(ms);
}

const CARD = (amount: string) =>
  `<main><div class="card"><h3>Economy</h3><div>${amount} per day</div></div></main>`;

beforeEach(() => {
  vi.useFakeTimers();
  installChrome();
  document.body.innerHTML = '';
  document.title = 'Hertz results';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('checking the trip the page priced', () => {
  // The detection half of the Avis fix. It shipped with no test at all: setting
  // VERIFY_TRIP to an empty set — turning `wrong-trip` off entirely in
  // production — left the whole suite green, because every other probe test
  // uses `vendor: 'hertz'`, for which the check is opt-out by design.
  //
  // jsdom implements `textContent` but not `innerText`, which is why the probe
  // reads one and falls back to the other; without that seam this file could
  // not exercise the path at all.

  const AVIS_TRIP: CarTrip = {
    category: 'car',
    pickupLocation: 'TPA',
    dropoffLocation: '',
    pickupDate: '2026-10-16',
    pickupTime: '12:00',
    dropoffDate: '2026-10-18',
    dropoffTime: '12:00',
  };

  const avisAssignment = (): StartAssignment => ({
    type: 'PROBE_START',
    vendor: 'avis',
    quoteId: 'avis:A1',
    timeoutMs: TIMEOUT_MS,
    trip: AVIS_TRIP,
    code: 'A1',
  });

  const summary = (dropOff: string) =>
    `<p>Tampa Intl Airport (TPA) - ${dropOff}</p>${CARD('$29.99')}`;

  it('fails the quote when the page priced a different trip', async () => {
    // The measured failure: a stale booking widget rendered Philadelphia as the
    // return for a link asking TPA to TPA. Real page, real price, wrong rental.
    assignment = avisAssignment();
    document.body.innerHTML = summary('Philadelphia Intl Airport (PHL)');
    await run(POLL * 2);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_FAILED');
    expect(sent[0]?.failure).toBe('wrong-trip');
    // The codes it saw, so the verdict can be argued with.
    expect(sent[0]?.message).toContain('PHL');
  });

  it('reports normally when the drop-off is simply unstated', async () => {
    // What the page shows once the stale store is cleared. Fewer codes than
    // asked for is the correct round trip, not a mismatch.
    assignment = avisAssignment();
    document.body.innerHTML = summary('Select drop-off location');
    await run(POLL * 2);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
  });

  it('reports rather than going silent when the check itself throws', async () => {
    // Without the catch, the rejection escapes probe(), `void main()` swallows
    // it, nothing is sent, and the background says "no answer before the
    // deadline" about a page that had already parsed prices — a confident wrong
    // diagnosis arriving by a different door.
    assignment = avisAssignment();
    // The *mismatching* summary on purpose. With a matching one a pass would be
    // ambiguous between "the catch worked" and "there was nothing to report":
    // this markup would fail as wrong-trip if the check ran at all, so a
    // PROBE_RESULT can only mean the throw was caught.
    document.body.innerHTML = summary('Philadelphia Intl Airport (PHL)');
    Object.defineProperty(document.body, 'innerText', {
      configurable: true,
      get() {
        throw new Error('innerText exploded');
      },
    });
    try {
      await run(POLL * 2);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.type).toBe('PROBE_RESULT');
    } finally {
      // An own property on document.body outlives innerHTML resets, so leaving
      // it defined makes every later test in this file catch and return null —
      // which silently turned the deadline test below into a false pass.
      Reflect.deleteProperty(document.body, 'innerText');
    }
  });

  it('checks the trip on the deadline path too', async () => {
    // A page whose prices never settle is reported at the deadline with
    // whatever it last saw. That path must not hand back a wrong trip either.
    assignment = { ...avisAssignment(), timeoutMs: POLL * 4 };
    await import('../src/content/probe.js');
    for (let i = 0; i < 4; i += 1) {
      document.body.innerHTML =
        `<p>Tampa Intl Airport (TPA) - Philadelphia Intl Airport (PHL)</p>` +
        CARD(`$${(30 + i).toString()}.99`);
      await vi.advanceTimersByTimeAsync(POLL);
    }
    await vi.advanceTimersByTimeAsync(POLL * 2);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.failure).toBe('wrong-trip');
  });

  it('leaves vendors that have not opted in alone', async () => {
    // The check reads a summary the vendor happens to render, which rots. A
    // Hertz page showing another airport must not start failing because Avis
    // needed a guard.
    assignment = { ...avisAssignment(), vendor: 'hertz', quoteId: 'hertz:H1' };
    document.body.innerHTML = summary('Philadelphia Intl Airport (PHL)');
    await run(POLL * 2);

    expect(sent[0]?.type).toBe('PROBE_RESULT');
  });
});

describe('staying inert', () => {
  it('says nothing when the background is not running a race', async () => {
    assignment = { type: 'PROBE_IDLE' };
    document.body.innerHTML = CARD('$29.99');
    await run(10_000);
    // The politeness contract: browsing Hertz normally must cost nothing.
    expect(sent).toEqual([]);
  });

  it('says nothing when there is no background at all', async () => {
    // Asserted against what the probe *attempted*, not against the recorder
    // the previous version had just thrown away — that made the test a
    // tautology no implementation could fail, and removing the try/catch this
    // claims to pin left all 14 green.
    const attempted: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: (message: Sent) => {
          attempted.push(message.type);
          return Promise.reject(new Error('no receiving end'));
        },
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    document.body.innerHTML = CARD('$29.99');
    await run(10_000);
    process.off('unhandledRejection', onUnhandled);

    // It asked once and stopped.
    expect(attempted).toEqual(['PROBE_READY']);
    // And it swallowed the rejection rather than letting it escape. This is
    // the half the previous version could not see: dropping the try/catch
    // changes nothing about what is *sent*, only whether an unhandled
    // rejection lands in the page's console on every ordinary page load.
    expect(unhandled).toEqual([]);
  });
});

describe('waiting for the page to settle', () => {
  it('does not report the first read it sees', async () => {
    // One read is not a settled page. Reporting it would ship a price scraped
    // mid-render, which is the whole reason this polls rather than reads once.
    document.body.innerHTML = CARD('$29.99');
    await run(POLL);
    expect(sent).toEqual([]);
  });

  it('reports once two consecutive reads agree', async () => {
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([29.99]);
  });

  it('keeps waiting while the price is still moving', async () => {
    document.body.innerHTML = CARD('$29.99');
    await run(POLL);
    document.body.innerHTML = CARD('$34.99');
    await run(POLL);
    // Changed between reads, so the counter reset — nothing reported yet.
    expect(sent).toEqual([]);
    await run(POLL);
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([34.99]);
  });

  it('treats an empty read as still loading, not as an answer', async () => {
    document.body.innerHTML = '<main><p>Searching…</p></main>';
    await run(POLL * 4);
    expect(sent).toEqual([]);
  });

  it('does not count an empty read towards stability', async () => {
    // A page that flickers empty between two identical reads has not settled.
    document.body.innerHTML = CARD('$29.99');
    await run(POLL);
    document.body.innerHTML = '<main><p>Updating…</p></main>';
    await run(POLL);
    document.body.innerHTML = CARD('$29.99');
    await run(POLL);
    expect(sent).toEqual([]);
  });
});

describe("a price outside the vendor's container", () => {
  // The Hertz regression, reproduced. Its results page is entirely
  // client-rendered — the server sends ~17KB with no `<main>` — and a Car Sales
  // promo reading "Like-new cars for under $20,000" sits outside the results
  // container. It never changes, so the settle check was satisfied on the
  // second poll and every quote came back at $20,000.
  //
  // Note the fixture used by the tests above wraps its card in `<main>`, which
  // is why none of them saw this.
  const PROMO = '<div class="footer-promo">Like-new cars for under $20,000</div>';

  it('does not settle early on a promo while no container holds prices', async () => {
    document.body.innerHTML = PROMO;
    await run(POLL * 6);
    expect(sent).toEqual([]);
  });

  it('still labels it body-fallback when the deadline arrives', async () => {
    // Run to the *deadline*, not for six polls. The six-poll version of this
    // asserted only that the promo does not settle early, and read as though
    // the regression were reproduced — it was not. At the deadline the promo
    // does go out, and what stops it being ranked is the label plus the
    // `scope-lost` marking the background applies from it.
    document.body.innerHTML = PROMO;
    await run(TIMEOUT_MS + POLL);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.report?.path).toBe('body-fallback');
  });

  it('does not settle early once an empty container renders either', async () => {
    // The case that killed the first version of this fix, which asked whether a
    // container *existed* rather than whether the prices came from one. Hertz
    // commits its shell before the rates arrive, so `<main>` is there and empty
    // while the advert is still the only price on the page.
    document.body.innerHTML = `${PROMO}<main><div class="skeleton">Loading vehicles</div></main>`;
    await run(POLL * 6);
    expect(sent).toEqual([]);
  });

  it('labels the empty-container case body-fallback at the deadline too', async () => {
    document.body.innerHTML = `${PROMO}<main><div class="skeleton">Loading vehicles</div></main>`;
    await run(TIMEOUT_MS + POLL);
    expect(sent[0]?.report?.path).toBe('body-fallback');
  });

  it('reports the container price once the page finally renders it', async () => {
    document.body.innerHTML = PROMO;
    await run(POLL * 3);
    expect(sent).toEqual([]);

    document.body.innerHTML = PROMO + CARD('$29.99');
    await run(POLL * 2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([29.99]);
  });

  it('still reports a body sweep at the deadline rather than losing it', async () => {
    // The half that makes waiting safe. A vendor whose results page genuinely
    // has no container we know about would otherwise go from priced to
    // `probe-empty` — real prices thrown away to protect against somebody
    // else's promo. Waiting gives a late container the rest of the budget to
    // appear and win; if none ever does, this is still the answer.
    document.body.innerHTML = '<div class="card"><h3>Economy</h3><div>$29.99 per day</div></div>';
    await run(TIMEOUT_MS + POLL);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([29.99]);
  });

  it('says in the report that the scope was lost', async () => {
    // `body-fallback` is what makes the above readable afterwards: without it a
    // sweep that reached a footer is indistinguishable from an ordinary one.
    document.body.innerHTML = '<div class="card"><h3>Economy</h3><div>$29.99 per day</div></div>';
    await run(TIMEOUT_MS + POLL);
    expect(sent[0]?.report?.path).toBe('body-fallback');
  });
});

describe('running out of time', () => {
  it('sends a partial result rather than nothing', async () => {
    // The page never settles — the price moves on every single read — so the
    // stable path is never taken and the deadline arrives with offers in hand.
    // Reporting `probe-empty` here would say "no price appeared" about a page
    // that showed one on every poll.
    document.body.innerHTML = CARD('$29.99');
    await import('../src/content/probe.js');
    for (let i = 0; i < 30; i += 1) {
      document.body.innerHTML = CARD(`$${(30 + i).toString()}.99`);
      await vi.advanceTimersByTimeAsync(POLL);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
    // The *latest* read, not a stale first one: reporting the first price it
    // ever saw at the deadline would be as wrong as reporting none.
    //
    // Derived, not hardcoded. The 40s deadline admits reads at t = 1500·k while
    // t < 40000, so k runs 1..27 and the 27th read is the last — 27 polls, not
    // the 26 an earlier version of this comment claimed. Written as arithmetic
    // so that changing POLL_INTERVAL_MS fails with a number that explains
    // itself, instead of `expected [40.99] to equal [56.99]`.
    // The probe sleeps a full interval *then* reads, so the read that trips the
    // deadline still happens: reads land at 1500·k for k = 1..27, the last at
    // t=40500. That is ceil(40000/1500) = 27, with no adjustment — subtracting
    // one here was the same off-by-one the old comment had.
    const reads = Math.ceil(TIMEOUT_MS / POLL);
    expect(reads).toBe(27);
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([30 + (reads - 1) + 0.99]);
  });

  it('reports probe-empty when it never saw a price', async () => {
    document.body.innerHTML = '<main><p>No vehicles available.</p></main>';
    await run(45_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.failure).toBe('probe-empty');
    expect(sent[0]?.report?.offerCount).toBe(0);
  });
});

describe('what it is allowed to claim', () => {
  it('reports extract-threw when the extractor throws on the markup', async () => {
    // One of only two failures a content script may claim, and it had no test.
    const extract = await import('../src/core/extract.js');
    vi.spyOn(extract, 'extract').mockImplementation(() => {
      throw new Error('selector blew up');
    });
    document.body.innerHTML = CARD('$29.99');
    await run(POLL);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.failure).toBe('extract-threw');
    expect(sent[0]?.message).toContain('selector blew up');
  });
});

describe('the report it attaches', () => {
  it('carries the path but never the query string', async () => {
    // The query holds the discount code and the user's itinerary.
    window.history.replaceState({}, '', '/rentacar/results?cdp=H1&pickup=SFO');
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);

    const report = sent[0]?.report;
    expect(report?.finalPath).toBe('/rentacar/results');
    expect(JSON.stringify(report)).not.toContain('H1');
    expect(JSON.stringify(report)).not.toContain('SFO');
  });

  it('records the branch that produced the offers', async () => {
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);
    expect(sent[0]?.report?.path).toBe('generic-sweep');
  });

  it('carries the page title, and caps it', async () => {
    // The worker's pass-through of `title` was pinned; the probe's own capture
    // was not, so replacing it with `''` left the suite green. The title is
    // what tells a consent interstitial or a country picker apart from a
    // results page that simply had no price — the whole reason the report
    // exists — and an empty one silently removes that.
    document.title = 'T'.repeat(300);
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);

    const title = sent[0]?.report?.title ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith('T')).toBe(true);
  });
});

describe('delivering the payload', () => {
  it('retries once when the worker is mid-restart', async () => {
    // Swallowing this does not lose a log line, it loses the result: the
    // background then times the quote out and tells the user no price
    // appeared, for a page where prices were found and parsed.
    failNext = 1;
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('PROBE_RESULT');
  });

  it('gives up after the second failure rather than looping', async () => {
    failNext = 2;
    document.body.innerHTML = CARD('$29.99');
    await run(POLL * 2);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toEqual([]);
  });
});
