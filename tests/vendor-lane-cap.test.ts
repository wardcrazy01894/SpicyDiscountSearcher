/**
 * `Vendor.maxLanes` — one vendor held to fewer tabs than the run's concurrency.
 *
 * The reason it exists is measured rather than theoretical: National keeps the
 * previous search in session state, including the account number, and tabs in
 * one profile share it. Two lanes racing two codes there can settle on one, and
 * the popup would report one company's price under another's code — the "real
 * page, real price, wrong rental" failure this codebase is organised around.
 *
 * These used to inject a fake cap onto `hertz`, because the only capped vendors
 * were ones no run could route to — a capped vendor that never opens a tab
 * proves nothing. **Avis is capped now**, and it deep-links and opens real tabs,
 * so the injection is gone and the mechanism is exercised against the shipping
 * configuration instead of a mock of it.
 *
 * The three caps do not rest on equal evidence, and flattening them is the
 * mistake this file keeps having to undo:
 *
 * - **National** is measured. Its form returns carrying the previous search's
 *   account number, so a second lane really can settle on the wrong code.
 * - **Enterprise** is analogy to National, with no measurement of its own.
 * - **Avis** is the weakest of the three. Its one *demonstrated* cross-tab leak
 *   — the saved booking widget that priced the wrong journey — was measured and
 *   provably does **not** carry the code: the location sat in localStorage, the
 *   code sits in per-tab sessionStorage. What the cap rests on is a prior about
 *   the vendor, which has been seen letting remembered state beat an explicit
 *   URL parameter, plus the fact that the remaining server-side route cannot be
 *   checked while no Avis code moves a price.
 *
 * `hertz` is the uncapped control, comparatively rather than by measurement:
 * nobody has dumped Hertz's storage the way Avis's was dumped. It has simply
 * never been seen doing any of this, and its deep link was replay-proved to
 * drive the search from the query string alone, differing inventory counts and
 * all — evidence of a stateless search rather than proof of an empty one. If
 * Hertz ever leaks, it earns the same cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChromeHarness } from './helpers/chrome-mock.js';
import { installChromeMock } from './helpers/chrome-mock.js';
import { VENDORS } from '../src/core/vendors.js';
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

function planOf(concurrency: number, vendors: Array<'avis' | 'hertz'>): SearchPlan {
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
});

afterEach(() => {
  chromeMock.restore();
  vi.useRealTimers();
});

describe('a vendor capped below the run concurrency', () => {
  it('never opens two tabs at that vendor at once', async () => {
    await bootWorker();
    // Four codes, four lanes, and every one of them at the capped vendor.
    await chromeMock.fromPopup({
      type: 'START_RUN',
      plan: planOf(4, ['avis', 'avis', 'avis', 'avis']),
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
      plan: planOf(4, ['avis', 'avis', 'avis', 'avis']),
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
      plan: planOf(3, ['avis', 'avis', 'avis', 'hertz', 'hertz']),
    });
    await settle();

    expect(chromeMock.tabs.size).toBe(3);
    const openVendors = chromeMock.tabOptions.map((t) =>
      new URL(t.options.url!).host.includes('hertz') ? 'hertz' : 'avis',
    );
    expect(openVendors.filter((v) => v === 'avis')).toHaveLength(1);
    expect(openVendors.filter((v) => v === 'hertz')).toHaveLength(2);
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
      plan: planOf(4, ['avis', 'avis', 'avis', 'avis']),
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
  it('holds every vendor a second tab could settle on the wrong code to one lane', () => {
    // Deliberately not "every vendor that leaks" — only National's leak is
    // measured to carry the code. See this file's header for what each of the
    // three actually rests on; they are not the same strength and an earlier
    // version of this title said they were.
    //
    // Avis's route here is the one worth remembering. The client-side worry
    // really was measured away — the AWD lives in per-tab sessionStorage, and
    // `booking-widget.store` carries no code — and for two rounds that was read
    // as "no cap needed". It does not support that: what it leaves open is a
    // shared server-side session, which *nothing* can close, because no Avis
    // code was found to move a price and so no observable delta exists for a
    // leak to show up in. Unfalsifiable is not absent, and Enterprise is capped
    // on less than this.
    const capped = VENDORS.filter((v) => v.maxLanes === 1).map((v) => v.id);
    expect(capped).toEqual(['avis', 'enterprise', 'national']);
  });

  it('leaves the vendors with no such hazard uncapped', () => {
    // Hertz has never been seen to leak anything between tabs, and its deep link
    // was replay-proved to drive the search from the query string alone. Not the
    // same as a storage dump proving it holds nothing — see this file's header.
    const uncapped = VENDORS.filter((v) => v.maxLanes === undefined).map((v) => v.id);
    expect(uncapped).toContain('hertz');
    expect(uncapped).not.toContain('avis');
  });
});
