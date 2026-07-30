import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChromeHarness } from './helpers/chrome-mock.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import type { CarTrip, Offer, RunState, SearchPlan } from '../src/core/types.js';

const TRIP: CarTrip = {
  category: 'car',
  pickupLocation: 'TPA',
  dropoffLocation: '',
  pickupDate: '2026-09-04',
  pickupTime: '10:00',
  dropoffDate: '2026-09-11',
  dropoffTime: '10:00',
};

function plan(concurrency = 2): SearchPlan {
  return {
    trip: TRIP,
    candidates: [
      { companySlug: 'acme', companyName: 'Acme', vendor: 'hertz', code: 'H1', note: null },
      { companySlug: 'globex', companyName: 'Globex', vendor: 'avis', code: 'A1', note: null },
    ],
    concurrency,
  };
}

const OFFER: Offer = { label: 'Compact', amount: 200, currency: 'USD', basis: 'total' };

let chromeMock: ChromeHarness;

/** Install the fake chrome, then load a fresh copy of the worker onto it. */
async function bootWorker(): Promise<void> {
  chromeMock = installChromeMock();
  vi.resetModules();
  await import('../src/background/service-worker.js');
  // Let the module-level orphan reaper settle before anything else runs.
  await vi.advanceTimersByTimeAsync(0);
}

async function getState(): Promise<RunState | null> {
  const reply = (await chromeMock.fromPopup({ type: 'GET_STATE' })) as { state: RunState | null };
  return reply.state;
}

/** Let pending lane work run without burning the probe timeout. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  chromeMock.restore();
  vi.useRealTimers();
});

describe('starting a run', () => {
  it('opens exactly one window even though both lanes start together', async () => {
    // Every lane awaits publish() before reaching ensureWindow, so a
    // check-then-create opened one window per lane and only ever closed the
    // last — an invisible minimised window leaked on every default run.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    expect(chromeMock.windowsCreated).toHaveLength(1);
    expect(chromeMock.windows.size).toBe(1);
    expect(chromeMock.tabs.size).toBe(2);
  });

  it('closes every tab and the window once the race finishes', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    for (const tabId of [...chromeMock.tabs.keys()]) {
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
    }
    await settle(1_000);

    const state = await getState();
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(state?.quotes.every((q) => q.status === 'ok')).toBe(true);
    expect(chromeMock.tabs.size).toBe(0);
    expect(chromeMock.windows.size).toBe(0);
  });

  it('finishes the run even when the state cannot be persisted', async () => {
    // An unguarded publish() rejection escaped runQuote, rejected the
    // Promise.all in startRun and skipped teardown entirely, leaving the
    // window open and the popup on "Racing codes…" forever.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    chromeMock.failNextSessionWrite();
    for (const tabId of [...chromeMock.tabs.keys()]) {
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
    }
    await settle(1_000);

    const state = await getState();
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(chromeMock.windows.size).toBe(0);
  });
});

describe('politeness', () => {
  // CLAUDE.md: "tabs open in a minimised window and close as soon as they
  // answer... Keep it that way. This opens real tabs on real vendor sites."
  // Every one of these lives in an argument, so without pinning them the
  // contract could be broken with the whole suite still green.

  it('opens its window minimised and unfocused', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    expect(chromeMock.windowOptions).toHaveLength(1);
    expect(chromeMock.windowOptions[0]).toMatchObject({ state: 'minimized', focused: false });
  });

  it('never steals focus with a probe tab', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    expect(chromeMock.tabOptions).toHaveLength(2);
    expect(chromeMock.tabOptions.every((t) => t.options.active === false)).toBe(true);
    // And into the run's own window, never the user's.
    const ours = chromeMock.windowsCreated[0];
    expect(chromeMock.tabOptions.every((t) => t.options.windowId === ours)).toBe(true);
  });

  it('leaves a gap between consecutive tabs in one lane', async () => {
    await bootWorker();
    // One lane, three candidates, so the stagger is observable in one queue.
    const solo = { ...plan(1) };
    solo.candidates = [
      ...plan().candidates,
      { companySlug: 'initech', companyName: 'Initech', vendor: 'budget', code: 'B1', note: null },
    ];
    await chromeMock.fromPopup({ type: 'START_RUN', plan: solo });
    await settle();

    for (let step = 0; step < 3; step += 1) {
      const tabId = [...chromeMock.tabs.keys()].at(-1);
      if (tabId === undefined) break;
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
      await settle(1_000);
    }

    const gaps = chromeMock.tabOptions
      .slice(1)
      .map((tab, index) => tab.at - chromeMock.tabOptions[index]!.at);
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(750);
  });

  it('caps concurrency at six however many the popup asks for', async () => {
    await bootWorker();
    const greedy = { ...plan(50) };
    greedy.candidates = Array.from({ length: 12 }, (_, index) => ({
      companySlug: `c${index}`,
      companyName: `Company ${index}`,
      vendor: 'hertz' as const,
      code: `H${index}`,
      note: null,
    }));
    await chromeMock.fromPopup({ type: 'START_RUN', plan: greedy });
    await settle();

    expect(chromeMock.tabs.size).toBe(6);
  });
});

describe('probe assignment', () => {
  it('tells a tab it never opened to stand down', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    const reply = await chromeMock.fromTab(9999, { type: 'PROBE_READY' });
    expect(reply).toEqual({ type: 'PROBE_IDLE' });
  });

  it('assigns each tab the vendor of its own quote', async () => {
    // Honest scope note: this does NOT cover the `?? 'hertz'` fallback that was
    // removed alongside it. Reaching that needs a tab mapped in run.tabs whose
    // quote is missing from state.quotes — an impossible state unreachable
    // through the message protocol, so the guard against it stays unpinned.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    const assignments = [];
    for (const tabId of [...chromeMock.tabs.keys()]) {
      assignments.push(await chromeMock.fromTab(tabId, { type: 'PROBE_READY' }));
    }
    expect(assignments.map((a) => (a as { vendor: string }).vendor).sort()).toEqual([
      'avis',
      'hertz',
    ]);
  });

  it('stands a probe down once its deadline has passed', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await settle(41_000);

    expect(await chromeMock.fromTab(tabId, { type: 'PROBE_READY' })).toEqual({
      type: 'PROBE_IDLE',
    });
  });

  it('hands out the time left, not a fresh budget, after a redirect', async () => {
    // The probe deadline is absolute. A vendor bouncing through a consent
    // interstitial re-injects the content script, and handing it another full
    // budget meant the background killed the tab partway through what the
    // probe believed was its own deadline.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    const first = (await chromeMock.fromTab(tabId, { type: 'PROBE_READY' })) as {
      timeoutMs: number;
    };
    await settle(10_000);
    const afterRedirect = (await chromeMock.fromTab(tabId, { type: 'PROBE_READY' })) as {
      timeoutMs: number;
    };

    expect(afterRedirect.timeoutMs).toBeLessThanOrEqual(first.timeoutMs - 10_000);
  });
});

describe('cancelling', () => {
  it('closes the tabs and window and marks every unfinished quote cancelled', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    await chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await settle();

    const state = await getState();
    expect(state?.quotes.every((q) => q.status === 'cancelled')).toBe(true);
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(chromeMock.tabs.size).toBe(0);
    expect(chromeMock.windows.size).toBe(0);
  });

  it('ignores a probe reporting in after the run was cancelled', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();
    const tabId = [...chromeMock.tabs.keys()][0]!;

    await chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
    await settle();

    const state = await getState();
    expect(state?.quotes.every((q) => q.status === 'cancelled')).toBe(true);
  });
});

describe('a tab the user closes', () => {
  it('releases its lane instead of blocking until the timeout', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    chromeMock.userClosesTab(tabId);
    await settle(1_000);

    const state = await getState();
    const closed = state?.quotes.find((q) => q.finishedAt);
    expect(closed?.status).toBe('no-price');
    expect(closed?.message).toContain('tab closed');
  });
});

describe('a run the browser interrupted', () => {
  it('is settled on read rather than left looking live forever', async () => {
    // MV3 can suspend the worker mid-race. The snapshot then still says
    // "loading", so the popup computed running = true and disabled the Run
    // button on every open for the rest of the session — and Cancel could not
    // clear it, because cancelRun() returns early with no active run.
    const zombie: RunState = {
      runId: 'run-1',
      plan: plan(2),
      startedAt: Date.now(),
      quotes: [
        {
          id: 'hertz:H1',
          candidate: plan().candidates[0]!,
          url: 'https://www.hertz.com/',
          status: 'loading',
          offers: [],
          best: null,
        },
      ],
    };

    await bootWorker();
    chromeMock.session.set('runState', zombie);

    const state = await getState();
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(state?.quotes[0]?.status).toBe('error');
    expect(state?.quotes[0]?.message).toContain('interrupted');
  });

  it('closes the window its worker orphaned', async () => {
    // Nothing else ever will: the window is minimised and holds a new-tab
    // page, so it outlives the probe tabs and the user cannot see it.
    chromeMock = installChromeMock();
    const orphan = (await (
      globalThis as unknown as { chrome: typeof chrome }
    ).chrome.windows.create({})) as { id: number };
    chromeMock.session.set('runWindow', orphan.id);
    expect(chromeMock.windows.has(orphan.id)).toBe(true);

    vi.resetModules();
    await import('../src/background/service-worker.js');
    await vi.advanceTimersByTimeAsync(0);

    expect(chromeMock.windows.has(orphan.id)).toBe(false);
    expect(chromeMock.session.has('runWindow')).toBe(false);
  });
});
