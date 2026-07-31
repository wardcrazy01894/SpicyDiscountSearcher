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

/** src/content/probe.ts POLL_INTERVAL_MS. */
const POLL = 1_500;

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
  assignment = { type: 'PROBE_START', vendor: 'hertz', quoteId: 'hertz:H1', timeoutMs: 40_000 };
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
    // ever saw at the deadline would be as wrong as reporting none. The 40s
    // deadline lands after 26 polls of 1.5s, so $56.99 is the last read and
    // $30.99 was the first.
    expect(sent[0]?.offers?.map((o) => o.amount)).toEqual([56.99]);
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
