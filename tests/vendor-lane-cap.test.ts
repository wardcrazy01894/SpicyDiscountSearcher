/**
 * `Vendor.maxLanes` — one vendor held to fewer tabs than the run's concurrency.
 *
 * The reason it exists is measured rather than theoretical: National keeps the
 * previous search in session state, including the account number, and tabs in
 * one profile share it. Two lanes racing two codes there can settle on one, and
 * the popup would report one company's price under another's code — the "real
 * page, real price, wrong rental" failure this codebase is organised around.
 *
 * Tested against an injected cap rather than against National itself, because
 * National is still `searchable: false`: its builder throws, `makeQuote` settles
 * the quote at plan time, and it never reaches the queue at all. Capping a
 * vendor nothing can route to would prove nothing, so these mock `findVendor` to
 * cap `hertz` — the same shape, on a vendor that really does open tabs. The
 * production values live in `vendors.ts` and are asserted at the bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChromeHarness } from './helpers/chrome-mock.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import { VENDORS } from '../src/core/vendors.js';
import type * as VendorsModule from '../src/core/vendors.js';
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

const OFFER: Offer = { label: 'Compact', amount: 200, currency: 'USD', basis: 'total' };
const REPORT: ProbeReport = {
  finalPath: '/us/en/book/vehicles',
  title: 'Results',
  offerCount: 1,
  path: 'generic-sweep',
};

let chromeMock: ChromeHarness;

/** Cap `hertz` at one lane, leaving every other vendor as it really is. */
function capHertz(): void {
  vi.doMock('../src/core/vendors.js', async () => {
    const actual = await vi.importActual<typeof VendorsModule>('../src/core/vendors.js');
    return {
      ...actual,
      findVendor: (id: string) => {
        const vendor = actual.findVendor(id);
        return vendor && id === 'hertz' ? { ...vendor, maxLanes: 1 } : vendor;
      },
    };
  });
}

async function bootWorker(): Promise<void> {
  chromeMock = installChromeMock();
  vi.resetModules();
  await import('../src/background/service-worker.js');
  await vi.advanceTimersByTimeAsync(0);
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function getState(): Promise<RunState | null> {
  const reply = (await chromeMock.fromPopup({ type: 'GET_STATE' })) as { state: RunState | null };
  return reply.state;
}

function planOf(concurrency: number, vendors: Array<'hertz' | 'avis'>): SearchPlan {
  return {
    trip: TRIP,
    concurrency,
    candidates: vendors.map((vendor, index) => ({
      companySlug: `c${index}`,
      companyName: `Company ${index}`,
      vendor,
      code: `${vendor.toUpperCase()}${index}`,
      note: null,
    })),
  };
}

/** Answer whichever tabs are open, then let the stagger elapse. */
async function answerOpenTabs(): Promise<void> {
  for (const tabId of [...chromeMock.tabs.keys()]) {
    await chromeMock.fromTab(tabId, { type: 'PROBE_RESULT', offers: [OFFER], report: REPORT });
  }
  await settle(1_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  capHertz();
});

afterEach(() => {
  chromeMock.restore();
  vi.useRealTimers();
  vi.doUnmock('../src/core/vendors.js');
});

describe('a vendor capped below the run concurrency', () => {
  it('never opens two tabs at that vendor at once', async () => {
    await bootWorker();
    // Four codes, four lanes, and every one of them at the capped vendor.
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: planOf(4, ['hertz', 'hertz', 'hertz', 'hertz']),
    });
    await settle();

    // Without the cap this is 4 — which is what shipped before, and what would
    // let two National tabs share one account number.
    expect(chromeMock.tabs.size).toBe(1);
  });

  it('still runs every one of them, one after another', async () => {
    await bootWorker();
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: planOf(4, ['hertz', 'hertz', 'hertz', 'hertz']),
    });
    await settle();

    // Serialised, not dropped. A lane that returned instead of parking would
    // leave these quotes unrun with the run reported finished.
    for (let i = 0; i < 4; i += 1) {
      expect(chromeMock.tabs.size).toBeLessThanOrEqual(1);
      await answerOpenTabs();
    }

    const state = await getState();
    expect(state?.quotes).toHaveLength(4);
    expect(state?.quotes.every((q) => q.status === 'ok')).toBe(true);
    expect(chromeMock.tabOptions).toHaveLength(4);
  });

  it('does not stall a lane that could be running a different vendor', async () => {
    await bootWorker();
    // Three lanes; three capped-vendor codes queued first, then two uncapped.
    // A lane that blocked on the cap instead of skipping past it would open one
    // tab and idle the other two.
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: planOf(3, ['hertz', 'hertz', 'hertz', 'avis', 'avis']),
    });
    await settle();

    expect(chromeMock.tabs.size).toBe(3);
    const openVendors = chromeMock.tabOptions.map((t) =>
      new URL(t.options.url!).host.includes('hertz') ? 'hertz' : 'avis',
    );
    expect(openVendors.filter((v) => v === 'hertz')).toHaveLength(1);
    expect(openVendors.filter((v) => v === 'avis')).toHaveLength(2);
  });

  it('tears the run down cleanly while lanes are parked on the cap', async () => {
    // What this does and does not cover, because the difference was measured:
    // deleting `wakeLanes(run)` from `cancelRun` leaves this test **green**.
    // `cancelRun` closes the window and stamps `finishedAt` itself, so a parked
    // lane leaks a lane promise that never settles rather than stranding a
    // window. That leak is not observable through this harness.
    //
    // The test is still worth having: it pins that a cancel arriving while lanes
    // are parked settles every quote and closes the window, which is the part a
    // user would see. The surviving mutation is recorded in the comment on
    // `wakeLanes`, not hidden.
    await bootWorker();
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: planOf(4, ['hertz', 'hertz', 'hertz', 'hertz']),
    });
    await settle();
    expect(chromeMock.tabs.size).toBe(1);

    await chromeMock.fromPopup({ type: 'CANCEL_RUN' });
    await settle(1_000);

    const state = await getState();
    expect(state?.finishedAt).toBeTypeOf('number');
    expect(chromeMock.tabs.size).toBe(0);
    // The window is the thing a stranded lane would have held open. It was
    // created, and it is no longer open.
    expect(chromeMock.windowsCreated).toHaveLength(1);
    expect(chromeMock.windows.has(chromeMock.windowsCreated[0]!)).toBe(false);
  });
});

describe('the caps that actually ship', () => {
  it('holds the session-state vendors to one lane', () => {
    // National is measured: its form comes back carrying the previous search's
    // location, dates and account number. Enterprise keeps its search the same
    // way. Both are set now so the value is written down next to the evidence
    // rather than rediscovered when their drivers land.
    const capped = VENDORS.filter((v) => v.maxLanes === 1).map((v) => v.id);
    expect(capped).toEqual(['enterprise', 'national']);
  });

  it('leaves every other vendor uncapped', () => {
    // Including Avis, which CLAUDE.md records as *suspected* of the same
    // problem and never measured. Capping it would halve its throughput on a
    // hunch; this is a one-line change the day someone checks.
    const uncapped = VENDORS.filter((v) => v.maxLanes === undefined).map((v) => v.id);
    expect(uncapped).toContain('avis');
    expect(uncapped).toContain('hertz');
  });
});
