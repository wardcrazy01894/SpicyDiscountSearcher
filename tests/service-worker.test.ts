import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChromeHarness } from './helpers/chrome-mock.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import { buildDeepLink } from '../src/core/deeplinks.js';
import type { CarTrip, Offer, ProbeReport, RunState, SearchPlan } from '../src/core/types.js';

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

const REPORT: ProbeReport = {
  finalPath: '/rentacar/reservation/',
  title: 'Results',
  offerCount: 1,
  path: 'generic-sweep',
};

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
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
    }
    await settle(1_000);

    const state = await getState();
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(state?.quotes.every((q) => q.status === 'ok')).toBe(true);
    expect(chromeMock.tabs.size).toBe(0);
    expect(chromeMock.windows.size).toBe(0);
  });

  it('fails the quotes cleanly when no window can be opened', async () => {
    // chrome.windows.create is typed Promise<Window | undefined> and can
    // resolve undefined. The older typings said otherwise, so reading .id was
    // a crash waiting for the one call that failed.
    await bootWorker();
    chromeMock.failNextWindowCreate();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle(2_000);

    const state = await getState();
    const failed = state?.quotes.find((q) => q.status === 'error');
    expect(failed?.failure).toBe('tab-open');
    expect(failed?.message).toContain('could not open a background window');
    // Exactly one casualty. windowPromise is cleared in the catch, so the next
    // candidate opens a window of its own rather than inheriting the failure —
    // without that reset every remaining quote would fail the same way.
    expect(state?.quotes.filter((q) => q.failure === 'tab-open')).toHaveLength(1);
    expect(chromeMock.windows.size).toBe(1);
    expect(chromeMock.tabs.size).toBe(1);
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
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
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
      { companySlug: 'initech', companyName: 'Initech', vendor: 'sixt', code: 'S1', note: null },
    ];
    await chromeMock.fromPopup({ type: 'START_RUN', plan: solo });
    await settle();

    for (let step = 0; step < 3; step += 1) {
      const tabId = [...chromeMock.tabs.keys()].at(-1);
      if (tabId === undefined) break;
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
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

    // The code travels per quote, not per run. A driver types whatever arrives
    // here into the vendor's form, so handing every tab the first candidate's
    // code would race one code against itself and report it as several — a
    // result that looks entirely healthy. The trip is the same for every tab by
    // construction, and is asserted to have arrived at all.
    const paired = assignments.map((a) => a as { vendor: string; code: string; trip: unknown });
    expect(paired.find((a) => a.vendor === 'hertz')?.code).toBe('H1');
    expect(paired.find((a) => a.vendor === 'avis')?.code).toBe('A1');
    expect(paired.every((a) => a.trip !== undefined)).toBe(true);
    expect(paired[0]?.trip).toEqual(TRIP);
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

describe('diagnosing a run afterwards', () => {
  it('flags a deep link that landed on the vendor home page', async () => {
    // The silent failure README predicts: the home page still shows a
    // plausible "from $19/day", so the quote comes back ok and simply wins.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, finalPath: '/' },
    });
    await settle(1_000);

    const landed = (await getState())?.quotes.find((q) => q.suspect);
    expect(landed?.suspect).toBe('landed-elsewhere');
    expect(landed?.status).toBe('ok');
  });

  it('leaves a quote that reached a real results path unflagged', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) });
    await settle();

    for (const tabId of [...chromeMock.tabs.keys()]) {
      await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
    }
    await settle(1_000);

    expect((await getState())?.quotes.some((q) => q.suspect)).toBe(false);
  });

  it('keeps what the probe saw even when it found no price', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_FAILED',
      failure: 'probe-empty',
      message: 'polled to the deadline without seeing a price',
      report: { ...REPORT, offerCount: 0, title: 'No vehicles available' },
    });
    await settle(1_000);

    const quote = (await getState())?.quotes.find((q) => q.failure === 'probe-empty');
    // Without this, "it said no results for Hertz" cannot be told apart from a
    // tab that never loaded.
    expect(quote?.report?.title).toBe('No vehicles available');
    expect(quote?.report?.offerCount).toBe(0);
    expect(quote?.report?.path).toBe('generic-sweep');
  });

  it('records which extraction branch produced the offers', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, path: 'vendor-selectors' },
    });
    await settle(1_000);

    expect((await getState())?.quotes[0]?.report?.path).toBe('vendor-selectors');
  });

  it('carries each quote its own builder’s confidence, not a single value', async () => {
    // The plan mixes a verified vendor with an unverified one *inside the run*,
    // which is the whole point. Two earlier versions of this test did not:
    //
    // - `every(q => q.confidence === 'best-effort')` was true only while no
    //   builder was verified, and went red on a change that did not touch the
    //   worker at all.
    // - Comparing each quote against `buildDeepLink(...)` looked stronger but
    //   was weaker: with only hertz and avis in the plan, both sides return
    //   `verified`, so hard-coding `confidence: 'verified'` in makeQuote passed.
    //   Asserting an unverified vendor separately proved nothing about the
    //   worker, because that vendor was never in the run.
    //
    // With sixt — still best-effort — in the plan alongside two verified
    // vendors, a hard-coded flag fails whichever value it picks.
    await bootWorker();
    const mixed = { ...plan(3) };
    mixed.candidates = [
      ...plan().candidates,
      { companySlug: 'initech', companyName: 'Initech', vendor: 'sixt', code: 'S1', note: null },
    ];
    await chromeMock.fromPopup({ type: 'START_RUN', plan: mixed });
    await settle();

    const state = await getState();
    expect(state?.quotes).toHaveLength(3);
    for (const quote of state?.quotes ?? []) {
      const expected = buildDeepLink(quote.candidate.vendor, quote.candidate.code, TRIP);
      expect(quote.confidence).toBe(expected.confidence);
    }
    expect(new Set(state?.quotes.map((q) => q.confidence))).toEqual(
      new Set(['verified', 'best-effort']),
    );
  });
});

describe('a probe reporting something unexpected', () => {
  it('flags a failed quote that also landed on the home page', async () => {
    // "no price because the link missed its search" and "no price because the
    // results page was empty" are different answers to the same complaint.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_FAILED',
      failure: 'probe-empty',
      message: 'polled to the deadline without seeing a price',
      report: { ...REPORT, finalPath: '/', offerCount: 0 },
    });
    await settle(1_000);

    const quote = (await getState())?.quotes.find((q) => q.finishedAt);
    expect(quote?.suspect).toBe('landed-elsewhere');
  });

  it('will not let a page claim a failure only the background can know', async () => {
    // "cancelled" and "tab-closed" are the user's actions, not the page's.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_FAILED',
      failure: 'cancelled',
      message: 'pretending the user did this',
      report: REPORT,
    });
    await settle(1_000);

    expect((await getState())?.quotes.find((q) => q.finishedAt)?.failure).toBeUndefined();
  });

  it('does not trust `form-fill` from a page while nothing can emit it', async () => {
    // A different case from the unknown-code test below: `form-fill` is a
    // *known* QuoteFailure, and the invariant is that it stays off
    // PROBE_FAILURES until a driver exists to send it. Until then every
    // instance can only be forged, and the popup would render "could not fill
    // the search form" for a build with no form-filling code in it.
    //
    // Unpinned until now — the set could be extended and the suite stayed
    // green, which is the shape this repo pins deliberately elsewhere. The
    // driver PR deletes this test on purpose rather than by accident.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_FAILED',
      failure: 'form-fill',
      message: 'claiming a driver that does not exist',
      report: REPORT,
    });
    await settle(1_000);

    const quote = (await getState())?.quotes.find((q) => q.finishedAt);
    expect(quote?.failure).toBeUndefined();
    // The page's own message still survives, which is the point of downgrading
    // rather than dropping.
    expect(quote?.message).toContain('claiming a driver');
  });

  it('does not trust an unknown failure code from the page', async () => {
    // The content script runs in a page we do not control. An unrecognised code
    // is left unset rather than coerced, so the popup falls back to the message
    // the script did send instead of naming a failure nobody established.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_FAILED',
      failure: 'something-invented',
      message: 'whatever',
      report: REPORT,
    });
    await settle(1_000);

    // Unset, not coerced: rendering "page loaded, no price appeared" for a code
    // we do not recognise would be inventing the diagnosis this exists to stop.
    // The popup falls back to the message the script did send.
    const quote = (await getState())?.quotes.find((q) => q.finishedAt);
    expect(quote?.failure).toBeUndefined();
    expect(quote?.message).toBe('whatever');
  });

  it('survives a probe result with no report at all', async () => {
    // A content script from a previous build can still be live in an open tab
    // after an update, sending the old message shape.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
    await settle(1_000);

    const quote = (await getState())?.quotes.find((q) => q.finishedAt);
    expect(quote?.status).toBe('ok');
    expect(quote?.suspect).toBeUndefined();
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
    // Length first. `every()` is vacuously true on an empty array, so both
    // assertions below passed with the worker slicing the candidate list to
    // nothing — 33 other tests died and this one stayed green.
    expect(state?.quotes).toHaveLength(2);
    expect(state?.quotes.every((q) => q.status === 'cancelled')).toBe(true);
    // The code, not just the status. Asserting only the status left
    // `failure: 'cancelled'` deletable with the whole suite green — the one
    // failure code nothing pinned.
    expect(state?.quotes.every((q) => q.failure === 'cancelled')).toBe(true);
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
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
    await settle();

    const state = await getState();
    expect(state?.quotes).toHaveLength(2);
    expect(state?.quotes.every((q) => q.status === 'cancelled')).toBe(true);
  });
});

describe('a cancel landing while a lane is opening the window', () => {
  it('does not leave a second window nobody can close', async () => {
    // runQuote checks run.cancelled before and after ensureWindow, but the
    // `await publish()` between them is a suspension point. A lane parked there
    // when CANCEL_RUN arrives resumes to find windowPromise nulled by
    // closeWindow and creates a window *after* the run was cancelled. Nothing
    // in this worker closes it: the run is torn down, and reapOrphanWindow only
    // runs at startup. The user sees nothing, because it is minimised and holds
    // a new-tab page.
    //
    // The delay is what makes the race writable. With a session write that
    // resolves instantly no lane is ever inside that window when the cancel
    // lands, and the same test passes whether the guard exists or not -- which
    // it did, on the first three attempts at writing it.
    await bootWorker();
    chromeMock.delaySessionWrites(500);
    // Not awaited: the delayed write is inside START_RUN's own handler, so
    // awaiting the reply here would wait out the very gap the cancel has to
    // land in.
    const started = chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    // beginRun's own publish clears at t=500; the lane then enters runQuote and
    // parks on its publish until t=1000. t=600 is inside that gap.
    await settle(600);
    const stopped = chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await settle(10_000);
    await Promise.all([started, stopped]);

    // windowsCreated is cumulative, so a window created after teardown shows
    // here even if something later closed it. Nothing does.
    expect(chromeMock.windowsCreated).toHaveLength(0);
    expect(chromeMock.windows.size).toBe(0);
    expect(chromeMock.tabs.size).toBe(0);
  });

  it('closes a window Chrome finished opening after the cancel landed', async () => {
    // The other half. The entry guard only helps a lane that has not started
    // creating yet; a cancel arriving while chrome.windows.create is in flight
    // gets past it, and closeWindow has already run by then. The id is not in
    // storage either -- that write comes after -- so nothing, in this worker or
    // the next one, would ever have a handle on it.
    await bootWorker();
    chromeMock.delayWindowCreate(800);
    const started = chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    // Far enough in for the lane to be inside windows.create, not before it.
    await settle(200);
    const stopped = chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await settle(10_000);
    await Promise.all([started, stopped]);

    // It was created -- that is the difference from the test above -- but it
    // must not still be open.
    expect(chromeMock.windowsCreated).toHaveLength(1);
    expect(chromeMock.windows.size).toBe(0);
  });

  it('does not report a cancelled quote as a tab-open failure', async () => {
    // ensureWindow now throws for a cancelled run, and runQuote's catch turns
    // any throw into `tab-open`. Left unhandled that writes "could not open a
    // tab" over quotes cancelRun had already settled -- blaming the extension
    // for what the user asked for, and showing in the popup as a broken vendor
    // rather than a stopped run.
    await bootWorker();
    chromeMock.delaySessionWrites(500);
    const started = chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle(600);
    const stopped = chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await settle(10_000);
    await Promise.all([started, stopped]);

    const state = await getState();
    expect(state?.quotes).toHaveLength(2);
    expect(state?.quotes.some((q) => q.failure === 'tab-open')).toBe(false);
    expect(state?.quotes.every((q) => q.failure === 'cancelled')).toBe(true);
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
    // The code, not the prose — a reworded message must not change what the
    // rest of the system believes happened.
    expect(closed?.failure).toBe('tab-closed');
  });
});

describe('a run the browser interrupted', () => {
  it('is settled on read rather than left looking live forever', async () => {
    // MV3 can suspend the worker mid-race. The snapshot then still says
    // "loading", so the popup computed running = true and disabled the Run
    // button on every open for the rest of the session — and Cancel could not
    // clear it, because cancelRun() returns early with no active run.
    const zombie: RunState = {
      plan: plan(2),
      quotes: [
        {
          id: 'hertz:H1',
          candidate: plan().candidates[0]!,
          url: 'https://www.hertz.com/',
          confidence: 'best-effort',
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
    expect(state?.quotes[0]?.failure).toBe('interrupted');
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

describe('a quote that timed out', () => {
  it('describes the tab the probe never reported on', async () => {
    // probe-timeout is the commonest failure and was the only one carrying no
    // evidence at all: the popup suppresses the whole evidence line when there
    // is no report, so the row said "no answer before the deadline" and
    // nothing else. A consent interstitial, a redirect to a country picker and
    // a page that never finished loading were indistinguishable — while the
    // background held a tab handle that answers the question.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    const tab = chromeMock.tabs.get(tabId)!;
    tab.url = 'https://www.hertz.com/rentacar/privacy-consent?redirect=x';
    tab.title = 'Before you continue';

    await settle(60_000);

    const quote = (await getState())?.quotes.find((q) => q.failure === 'probe-timeout');
    expect(quote?.report?.path).toBe('not-reached');
    expect(quote?.report?.finalPath).toBe('/rentacar/privacy-consent');
    expect(quote?.report?.title).toBe('Before you continue');
  });

  it('keeps the query string out of the report it builds', async () => {
    // Same rule the probe's own report follows: the query carries the discount
    // code and the user's itinerary, and this one is built from a tab url that
    // has both.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    chromeMock.tabs.get(tabId)!.url = 'https://www.hertz.com/results?cdp=H1&pickup=SFO';

    await settle(60_000);

    const report = (await getState())?.quotes.find((q) => q.failure === 'probe-timeout')?.report;
    expect(report?.finalPath).toBe('/results');
    expect(JSON.stringify(report)).not.toContain('H1');
    expect(JSON.stringify(report)).not.toContain('SFO');
  });

  it('still settles when the tab has already gone', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    // The tab vanishes before the deadline — the background has nothing left
    // to read, and must not turn that into an unhandled rejection.
    const tabId = [...chromeMock.tabs.keys()][0]!;
    chromeMock.tabs.delete(tabId);

    await settle(60_000);

    const quote = (await getState())?.quotes[0];
    expect(quote?.finishedAt).toBeDefined();
    expect(quote?.report).toBeUndefined();
  });
});

describe('an answer that arrives after the deadline', () => {
  it('records it instead of dropping it on the floor', async () => {
    // The probe's loop runs while Date.now() < deadline, so it can begin its
    // final extract one millisecond inside the window and spend arbitrary time
    // there. That reply used to be discarded entirely — offers, best price and
    // report — while the quote kept a probe-timeout saying nothing came back.
    // "The vendor never answered" and "the deadline is too short" need
    // opposite fixes.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await settle(60_000);

    const before = (await getState())?.quotes[0];
    expect(before?.failure).toBe('probe-timeout');

    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, offerCount: 1 },
    });
    await settle();

    const quote = (await getState())?.quotes[0];
    expect(quote?.lateReport?.offerCount).toBe(1);
    expect(quote?.lateReport?.finalPath).toBe(REPORT.finalPath);
  });

  it('does not resurrect the quote or rewrite its verdict', async () => {
    // The evidence is worth keeping; the result is not. Accepting a late
    // payload as the answer would let a page that missed its deadline win a
    // race the user already saw settled.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await settle(60_000);
    const finishedAt = (await getState())?.quotes[0]?.finishedAt;

    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: REPORT,
    });
    await settle();

    const quote = (await getState())?.quotes[0];
    expect(quote?.failure).toBe('probe-timeout');
    expect(quote?.status).toBe('no-price');
    expect(quote?.best).toBeNull();
    expect(quote?.offers).toEqual([]);
    expect(quote?.finishedAt).toBe(finishedAt);
  });
});

describe('the orphan-window reaper', () => {
  it('forgets an id whose window is genuinely gone', async () => {
    // The ordinary case: the user closed it themselves. Holding the id would
    // make every future worker retry a window that does not exist.
    chromeMock = installChromeMock();
    chromeMock.session.set('runWindow', 9999);

    vi.resetModules();
    await import('../src/background/service-worker.js');
    await vi.advanceTimersByTimeAsync(0);

    expect(chromeMock.session.has('runWindow')).toBe(false);
  });

  it('keeps the id of a window it could not close', async () => {
    // The key used to be dropped before the close was even attempted, so a
    // failed close left a window nothing could ever find again — it is
    // minimised and holds a new-tab page, so the user cannot see it to close
    // it either. The stored id is the only handle on it.
    chromeMock = installChromeMock();
    const orphan = (await chrome.windows.create({}))!.id!;
    chromeMock.session.set('runWindow', orphan);
    // Still open, but refusing to close — chrome does this when the window is
    // in a state it will not tear down.
    const windows = chrome.windows as unknown as { remove: (id: number) => Promise<void> };
    windows.remove = () => Promise.reject(new Error('cannot remove window'));

    vi.resetModules();
    await import('../src/background/service-worker.js');
    await vi.advanceTimersByTimeAsync(0);

    expect(chromeMock.session.get('runWindow')).toBe(orphan);
    expect(chromeMock.windows.has(orphan)).toBe(true);
  });
});

describe('a timed-out tab the extension cannot see', () => {
  it('says so, rather than claiming the tab never navigated', async () => {
    // The manifest grants no `tabs` permission — PR #5 dropped it — so
    // chrome omits url and title for a tab whose current URL is not one of
    // our nine vendor hosts. An off-origin redirect is therefore invisible,
    // and it is *also* exactly when the content script stops running, i.e. a
    // leading cause of probe-timeout. Reporting "never navigated" there was a
    // confident wrong answer in the case this whole feature exists for.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    const tab = chromeMock.tabs.get(tabId)!;
    tab.url = 'https://consent.example-cdn.com/gate?next=hertz';
    tab.title = 'Before you continue';

    await settle(60_000);

    const quote = (await getState())?.quotes.find((q) => q.failure === 'probe-timeout');
    expect(quote?.report?.path).toBe('left-our-origins');
    expect(quote?.report?.finalPath).toBe('');
    // Nothing invented from a field chrome did not give us.
    expect(quote?.report?.title).toBe('');
  });

  it('still reads a tab that stayed on the vendor', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    const tab = chromeMock.tabs.get(tabId)!;
    tab.url = 'https://www.hertz.com/rentacar/privacy-consent?x=1';
    tab.title = 'Before you continue';

    await settle(60_000);

    const quote = (await getState())?.quotes.find((q) => q.failure === 'probe-timeout');
    expect(quote?.report?.path).toBe('not-reached');
    expect(quote?.report?.finalPath).toBe('/rentacar/privacy-consent');
  });
});

describe('what a content script is allowed to claim', () => {
  it('refuses a forged "the background observed this" branch', async () => {
    // Same doctrine as PROBE_FAILURES: `not-reached` and `left-our-origins`
    // are the background's own knowledge, built from the tab after the probe
    // went silent. A page that could send one would be forging the
    // background's testimony, and the popup would print "no answer from the
    // page" about a page that had just answered.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, path: 'not-reached' },
    });
    await settle(1_000);

    const quote = (await getState())?.quotes[0];
    expect(quote?.report?.path).toBe('generic-sweep');
    // The observations themselves are still the probe's, and still kept.
    expect(quote?.report?.finalPath).toBe(REPORT.finalPath);
    expect(quote?.report?.offerCount).toBe(REPORT.offerCount);
  });

  it('keeps a branch it is allowed to claim', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, path: 'vendor-selectors' },
    });
    await settle(1_000);

    expect((await getState())?.quotes[0]?.report?.path).toBe('vendor-selectors');
  });
});

describe('the reaper and a run that starts underneath it', () => {
  it('does not delete a window id that changed while it was closing', async () => {
    // The interleave: the reaper reads orphan id 3 and calls windows.remove,
    // which is real IPC and takes tens of ms. During it a run starts, creates
    // its own window, and writes that id to the same key. A bare delete
    // afterwards drops the *live* run's id — and if the worker is then
    // suspended, the next wake finds no key and the minimised window leaks
    // permanently, invisibly. That is the exact leak this function exists to
    // fix, caused by the function itself.
    chromeMock = installChromeMock();
    const orphan = (await chrome.windows.create({}))!.id!;
    chromeMock.session.set('runWindow', orphan);

    let releaseRemove = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const windows = chrome.windows as unknown as { remove: (id: number) => Promise<void> };
    const realRemove = windows.remove;
    windows.remove = async (id: number) => {
      await held;
      return realRemove(id);
    };

    vi.resetModules();
    await import('../src/background/service-worker.js');
    await vi.advanceTimersByTimeAsync(0);

    // A run claims the key while the close is still in flight.
    chromeMock.session.set('runWindow', 999);
    releaseRemove();
    await vi.advanceTimersByTimeAsync(0);

    expect(chromeMock.session.get('runWindow')).toBe(999);
    windows.remove = realRemove;
  });
});

describe('a report a page could have forged', () => {
  it('keeps the query string out of a page-supplied path', async () => {
    // "Path only, never the query string" is the rule because the query holds
    // the discount code and the itinerary. It was enforced for the report the
    // *background* builds and merely trusted for the one the page sends —
    // which is persisted to storage and rendered.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, finalPath: '/search?cdp=SECRET&pickup=TPA' },
    });
    await settle(1_000);

    const state = await getState();
    expect(state?.quotes[0]?.report?.finalPath).toBe('/search');
    expect(JSON.stringify(state)).not.toContain('SECRET');
  });

  it('caps the strings a page can put into storage', async () => {
    // Unbounded, these fill chrome.storage.session's quota — and publish()
    // swallows that into a warn, so the run would silently stop persisting.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, title: 'X'.repeat(5_000), offerCount: -7 },
    });
    await settle(1_000);

    const report = (await getState())?.quotes[0]?.report;
    expect(report?.title.length).toBeLessThanOrEqual(200);
    // Rendered verbatim, so "-7 offers" was reachable.
    expect(report?.offerCount).toBe(0);
  });

  it('bounds the offers array, which is the bigger half of the same quota', async () => {
    // sanitizeReport's docstring justified its caps by chrome.storage.session's
    // quota, while `offers` from the same message went to the same storage
    // unbounded — so a page held to 200 characters of title could still send
    // megabytes. Capping the title closed nothing on its own.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: Array.from({ length: 5_000 }, () => ({
        label: 'L'.repeat(5_000),
        amount: 200,
        currency: 'USD',
        basis: 'total',
      })),
      report: REPORT,
    });
    await settle(1_000);

    const quote = (await getState())?.quotes[0];
    expect(quote?.offers.length).toBeLessThanOrEqual(200);
    expect(quote?.offers.every((o) => (o.label?.length ?? 0) <= 200)).toBe(true);
  });

  it('drops an offer whose amount is not a number rather than ranking on NaN', async () => {
    // bestOffer ranks on `amount`, and NaN compares false against everything —
    // so a coerced entry loses a race silently instead of failing one.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [
        { label: 'Junk', amount: 'not a number', currency: 'USD', basis: 'total' },
        { label: 'Real', amount: 150, currency: 'USD', basis: 'total' },
      ],
      report: REPORT,
    });
    await settle(1_000);

    const quote = (await getState())?.quotes[0];
    expect(quote?.offers).toHaveLength(1);
    expect(quote?.best?.amount).toBe(150);
  });

  it('refuses a basis it does not recognise', async () => {
    // `basis` decides which bucket a quote is ranked in, so a page inventing
    // one would place itself outside every comparison group — listed, never
    // ranked, and silently absent from the race the user is watching.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [{ label: 'X', amount: 99, currency: 'USD', basis: 'per-fortnight' }],
      report: REPORT,
    });
    await settle(1_000);

    expect((await getState())?.quotes[0]?.offers[0]?.basis).toBe('unknown');
  });

  it('caps finalPath as well as title', async () => {
    // The two caps are twins in the same expression and only title was pinned,
    // so the finalPath half could be deleted with the suite green. A path is
    // page-supplied like the title, goes to the same quota, and renders in the
    // same place.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, finalPath: `/${'p'.repeat(5_000)}` },
    });
    await settle(1_000);

    const report = (await getState())?.quotes[0]?.report;
    expect(report?.finalPath.length).toBeLessThanOrEqual(200);
  });

  it('sanitizes a late report too, not only a live one', async () => {
    // The late branch is a separate call site, and was separately trusted.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await settle(60_000);
    await chromeMock.fromTab(tabId, {
      type: 'PROBE_RESULT',
      offers: [OFFER],
      report: { ...REPORT, path: 'not-reached', finalPath: '/late?cdp=SECRET' },
    });
    await settle();

    const late = (await getState())?.quotes[0]?.lateReport;
    expect(late?.path).toBe('generic-sweep');
    expect(late?.finalPath).toBe('/late');
  });
});

describe('a tab whose navigation never landed', () => {
  it('does not claim it left the vendor, because that is not knowable', async () => {
    // An absent url means only "no permission to read this tab's address".
    // That is equally true of an off-origin redirect and of a load that never
    // committed. Round 1 blocked because "never navigated" was wrong for the
    // first; asserting the second would be the same mistake reversed.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    chromeMock.tabs.get(tabId)!.url = '';

    await settle(60_000);

    const report = (await getState())?.quotes.find((q) => q.failure === 'probe-timeout')?.report;
    // Same code as the off-origin case on purpose: the background cannot tell
    // them apart, so it does not pretend to.
    expect(report?.path).toBe('left-our-origins');
    expect(report?.finalPath).toBe('');
  });
});

describe('the stored window id belongs to whoever stored it', () => {
  it('does not wipe a foreign window id when its own run closes', async () => {
    // closeWindow routes through forgetWindowId, which compares before it
    // deletes. Reverting it to a bare storage.session.remove(WINDOW_KEY) passed
    // the whole suite, so the round-3 half of the compare-and-delete fix could
    // regress freely.
    //
    // The scenario: this worker's run finishes and closes its own window, while
    // the key holds a *different* window — an orphan left by a predecessor that
    // MV3 terminated mid-run. Deleting it unconditionally strands that window
    // permanently: it is minimised, holds a new-tab page, and its id was the
    // only handle any later worker had on it.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const mine = chromeMock.session.get('runWindow');
    expect(mine, 'the worker should have stored its window id').toBeDefined();
    chromeMock.session.set('runWindow', 4242);
    expect(mine).not.toBe(4242);

    const tabId = [...chromeMock.tabs.keys()][0]!;
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
    await settle(60_000);

    expect(chromeMock.session.get('runWindow')).toBe(4242);
  });
});

describe('a quote that answered is not described as silent', () => {
  it('leaves a successful quote without a background-built report', async () => {
    // describeSilentTab runs in the finally for *every* quote, so its
    // `failure !== 'probe-timeout'` half is the only thing keeping it off a
    // quote that answered. Dropping that half stamps `left-our-origins` — which
    // the popup renders as not having heard from the page — onto a quote whose
    // page replied with offers, which is the precise misattribution PROBE_PATHS
    // exists to prevent from the other direction.
    //
    // The probe is allowed to answer without a report: `report` is optional on
    // PROBE_RESULT, and that is the case where `quote.report` is falsy and only
    // the failure check stands.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const tabId = [...chromeMock.tabs.keys()][0]!;
    // No url either, so describeSilentTab would build a `left-our-origins`
    // report if it ran at all.
    chromeMock.tabs.get(tabId)!.url = '';
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER] });
    await settle(1_000);

    const quote = (await getState())?.quotes[0];
    expect(quote?.status).toBe('ok');
    expect(quote?.report).toBeUndefined();
  });
});

describe('two starts arriving at once', () => {
  it('opens one window and one set of tabs, not two', async () => {
    // cancelRun() returns immediately when `active` is null, so both messages
    // sailed past it and both built a run: two minimised windows, twice the
    // concurrency cap, twice the load on every vendor. A double-click on Run
    // was enough, because the popup only disabled the button when the reply
    // came back.
    await bootWorker();
    const both = Promise.all([
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
    ]);
    await both;
    await settle(1_000);

    expect(chromeMock.windowsCreated).toHaveLength(1);
    expect(chromeMock.tabs.size).toBeLessThanOrEqual(2);
  });

  it('leaves no window behind', async () => {
    // The first run's window id was overwritten in storage by the second, so
    // nothing could ever find it again — minimised, holding a new-tab page,
    // invisible to the user.
    await bootWorker();
    await Promise.all([
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
    ]);
    await settle(120_000);

    expect(chromeMock.windows.size).toBe(0);
  });

  it('answers the second caller with the run that is starting', async () => {
    // Not an error: from the user's side one Run press produced one race,
    // which is what they asked for.
    await bootWorker();
    const [, second] = await Promise.all([
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(2) }),
    ]);
    await settle();

    const reply = second as { type: string; state: RunState | null };
    expect(reply.type).toBe('RUN_STATE');
    // Not null, and not a stale finished run — the test name says "the run
    // that is starting", and type alone would pass for either.
    expect(reply.state).not.toBeNull();
    expect(reply.state?.finishedAt).toBeUndefined();
  });

  it('still allows a fresh run once the first has settled', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle(120_000);
    const before = chromeMock.windowsCreated.length;

    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    expect(chromeMock.windowsCreated.length).toBe(before + 1);
  });
});

describe('a second start arriving after an earlier run has finished', () => {
  it('answers with the run that is starting, not the one that ended', async () => {
    // `active` is never nulled, so it still points at the finished run while a
    // new one is being built. Answering the refused caller from `active` handed
    // it that finished state — and the popup reads `finishedAt` as "no run in
    // progress" and re-arms the button, which is the whole thing this guards.
    //
    // This is the case the earlier version actually got wrong. The burst on a
    // *fresh* worker did not: `active` is assigned before the refusal's catch
    // body runs, so that caller already saw the live run.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle(120_000);
    expect((await getState())?.finishedAt).toBeDefined();

    const [, second] = await Promise.all([
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) }),
      chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) }),
    ]);
    const reply = second as { state: RunState | null };

    expect(reply.state).not.toBeNull();
    expect(reply.state?.finishedAt).toBeUndefined();
    await settle(120_000);
  });
});

describe('a quote whose link could not be built', () => {
  it('records link-build rather than failing the whole run', async () => {
    // The one failure code with no test. buildDeepLink throws for an
    // unsearchable vendor, and makeQuote turns that into a finished quote so
    // the rest of the race carries on.
    await bootWorker();
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: {
        trip: plan(1).trip,
        candidates: [
          {
            companySlug: 'acme',
            companyName: 'Acme',
            vendor: 'starwood',
            code: 'SET1',
            note: null,
          },
          { companySlug: 'globex', companyName: 'Globex', vendor: 'hertz', code: 'H1', note: null },
        ],
        concurrency: 2,
      },
    });
    await settle(1_000);

    const quotes = (await getState())?.quotes ?? [];
    const failed = quotes.find((q) => q.candidate.vendor === 'starwood');
    expect(failed?.failure).toBe('link-build');
    expect(failed?.status).toBe('error');
    expect(failed?.finishedAt).toBeDefined();
    // The searchable vendor still ran. Asserted as present-and-not-error:
    // `undefined !== 'error'` would have passed for a quote that never existed.
    const ran = quotes.find((q) => q.candidate.vendor === 'hertz');
    expect(ran).toBeDefined();
    expect(ran?.status).not.toBe('error');
  });
});

describe('closing the run window', () => {
  it('keeps the id when the window refuses to close', async () => {
    // reapOrphanWindow has had this check since it was written; closeWindow was
    // claimed to be identical and was not, so a failed close here left a
    // minimised window holding a new-tab page that nothing could ever find.
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle();

    const live = [...chromeMock.windows][0]!;
    const windows = chrome.windows as unknown as { remove: (id: number) => Promise<void> };
    const realRemove = windows.remove;
    windows.remove = () => Promise.reject(new Error('cannot remove window'));

    await settle(120_000);

    expect(chromeMock.session.get('runWindow')).toBe(live);
    expect(chromeMock.windows.has(live)).toBe(true);
    windows.remove = realRemove;
  });

  it('forgets the id on a normal completion', async () => {
    await bootWorker();
    await chromeMock.fromPopup({ type: 'START_RUN', plan: plan(1) });
    await settle(120_000);

    expect(chromeMock.session.has('runWindow')).toBe(false);
    expect(chromeMock.windows.size).toBe(0);
  });

  it('does not wipe a foreign id when the run never opened a window', async () => {
    // An empty candidate list finishes without ever calling ensureWindow, so
    // `closing` is null — and an unconditional delete then dropped somebody
    // else's orphan id while that window was still open.
    await bootWorker();
    chromeMock.session.set('runWindow', 4242);
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: { trip: plan(1).trip, candidates: [], concurrency: 2 },
    });
    await settle(1_000);

    expect(chromeMock.session.get('runWindow')).toBe(4242);
  });
});
