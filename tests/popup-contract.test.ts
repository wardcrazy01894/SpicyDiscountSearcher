/**
 * @vitest-environment jsdom
 *
 * The popup's contract with its own HTML.
 *
 * `popup.ts` runs fifteen `el()` lookups at module top level — before the
 * `void main().catch(...)` at the bottom is installed — so a missing id throws
 * during module evaluation and the popup renders as dead HTML stuck on
 * "Loading codes…". Nothing else catches that: renaming one id in index.html
 * leaves typecheck, eslint, vitest, the build and check-dist all green while
 * the extension is completely non-functional, because `check-dist.mjs` verifies
 * that referenced *files* exist and never parses ids.
 *
 * These tests import the real module against the real HTML, so they cover the
 * whole import-time path rather than a hand-copied list of selectors that could
 * itself drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HTML = readFileSync(path.join(ROOT, 'src/popup/index.html'), 'utf8');
const BODY = /<body[^>]*>([\s\S]*)<\/body>/i.exec(HTML)?.[1] ?? '';

/** Every `el('#id')` selector the module resolves at import time. */
const SELECTORS = [
  '#trip-form',
  '#tagline',
  '#car-fields',
  '#hotel-fields',
  '#vendor-chips',
  '#company-search',
  '#company-list',
  '#max-codes',
  '#concurrency',
  '#plan-summary',
  '#run-btn',
  '#cancel-btn',
  '#results',
  '#savings',
  '#quotes',
  '#avis-captcha-btn',
  '#budget-captcha-btn',
  '#rejected-note',
  '#rejected-count',
  '#rejected-clear',
];

/** Every message the popup sent, so a double submit is countable. */
let sentMessages: Array<{ type: string }> = [];
/** The popup's RUN_STATE listener, so the background can push to it. */
let broadcastListeners: Array<(message: unknown) => void> = [];
/** Swapped by a test to make START_RUN reject the way a dead worker does. */
let sendMessageImpl: (message: { type: string }) => Promise<unknown> = () =>
  Promise.resolve({ type: 'RUN_STATE', state: null });

/** Seeded into chrome.storage.local before the popup boots. */
let savedForm: Record<string, unknown> | null = null;
/** Codes a vendor has already refused, as the background would have stored them. */
let savedRejected: Array<{ vendor: string; code: string; at: number }> | null = null;

/** The slice of chrome the popup touches while starting up. */
function installChrome(): void {
  const local = new Map<string, unknown>();
  if (savedForm) local.set('popupForm', savedForm);
  if (savedRejected) local.set('rejectedCodes', savedRejected);
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: () => Promise.resolve(Object.fromEntries(local)),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, v);
          return Promise.resolve();
        },
      },
    },
    runtime: {
      sendMessage: (message: { type: string }) => {
        sentMessages.push(message);
        return sendMessageImpl(message);
      },
      onMessage: {
        addListener: (fn: (message: unknown) => void) => {
          broadcastListeners.push(fn);
        },
      },
    },
  };
}

beforeEach(() => {
  sentMessages = [];
  broadcastListeners = [];
  savedForm = null;
  savedRejected = null;
  sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
  installChrome();
  document.body.innerHTML = BODY;
});

afterEach(() => {
  vi.resetModules();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('the popup against its own HTML', () => {
  it('imports and starts up without throwing', async () => {
    await expect(import('../src/popup/popup.js')).resolves.toBeDefined();
    // Startup got as far as the tagline. Not "nothing threw": `main()`'s own
    // catch swallows a later failure and writes it into the plan line, so
    // check that line too rather than claiming more than this can see.
    await vi.waitFor(() => {
      expect(document.querySelector('#tagline')?.textContent).toMatch(/corporate codes loaded/);
    });

    // Then wait past everything main() still has to do. Neither of the obvious
    // signals is one: the tagline is written *before* the GET_STATE round trip,
    // and the plan line is populated by `setCategory` before it too — so both
    // appear while main() is still pending, and a failure after them lands
    // later. Checked against either, this assertion was pinned to the chrome
    // stub resolving in a microtask rather than to the popup, and a mutant that
    // threw right after main() survived once the stub was delayed 30 ms.
    //
    // A fixed wait is the honest instrument here, since the thing being waited
    // for is "nothing else is coming" and no DOM state says that. 250 ms is an
    // age for a stub that resolves immediately.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(/Could not start up/);
  });

  it.each(SELECTORS)('finds %s in index.html', (selector) => {
    expect(document.querySelector(selector)).not.toBeNull();
  });

  it('has a selector for every el() call in the module, and no more', () => {
    // Guards the list above against drifting from the source it describes —
    // otherwise this file could keep passing while popup.ts grew a sixteenth
    // lookup nobody checked.
    const source = readFileSync(path.join(ROOT, 'src/popup/popup.ts'), 'utf8');
    const found = [...source.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(SELECTORS));
  });

  it('finds the category tabs the module wires listeners onto', () => {
    // Not an el() lookup, so it fails silently rather than loudly: no tabs
    // means no way to switch between cars and hotels, and no error either.
    expect(document.querySelectorAll('.tab').length).toBeGreaterThan(0);
  });

  it.each(SELECTORS)('fails loudly when %s is missing', async (selector) => {
    // The point of the whole file. Without this, renaming an id ships a dead
    // popup with every required check green.
    const id = selector.slice(1);
    document.body.innerHTML = BODY.replace(`id="${id}"`, `id="${id}-renamed"`);
    await expect(import('../src/popup/popup.js')).rejects.toThrow(/missing element/);
  });
});

describe('the popup half of the double-run guard', () => {
  /** Fill the car form so `validate` passes and submit is a real submit. */
  function fillCarForm(): void {
    const set = (name: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (field) field.value = value;
    };
    set('pickupLocation', 'TPA');
    set('pickupDate', '2026-09-04');
    set('dropoffDate', '2026-09-11');
  }

  async function boot(): Promise<void> {
    await import('../src/popup/popup.js');
    await vi.waitFor(() => {
      expect(document.querySelector('#tagline')?.textContent).toMatch(/corporate codes loaded/);
    });
  }

  /** What the background pushes when a race ends, which is when refusals land. */
  async function broadcastFinishedRun(): Promise<void> {
    for (const listener of broadcastListeners) {
      listener({
        type: 'RUN_STATE',
        state: {
          plan: {
            trip: {
              category: 'car',
              pickupLocation: 'TPA',
              dropoffLocation: '',
              pickupDate: '2026-09-04',
              pickupTime: '10:00',
              dropoffDate: '2026-09-11',
              dropoffTime: '10:00',
            },
            candidates: [],
            concurrency: 2,
          },
          quotes: [],
          finishedAt: Date.now(),
        },
      });
    }
    // Past the storage read the handler does before it decides to re-render.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('offers a codes cap high enough to race every car code, and enforces it', async () => {
    // 100 covers all 66 car candidates, so a car run can be exhaustive. The
    // number matters because nothing ranks the codes — `interleaveByVendor`
    // makes truncation *fair*, not *good*, so whatever the cap cuts is cut
    // arbitrarily.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes')!;
    expect(maxCodes.max).toBe('100');

    // And the attribute is not the enforcement. The browser checks `max` only
    // on submit and `.value` still reports whatever was typed, so the clamp has
    // to live in the code that builds the plan.
    //
    // Asserted on **hotels**, deliberately. There are only 66 car candidates,
    // so a 5000 cap slices nothing and the test passes with the clamp deleted —
    // which is exactly what happened to the first version of this. Hotels have
    // 401, so the clamp is the only thing standing between the typed number and
    // 401 tabs.
    document.querySelector<HTMLButtonElement>('.tab[data-category="hotel"]')?.click();
    maxCodes.value = '5000';
    maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/\d/);
    });
    const summary = document.querySelector('#plan-summary')?.textContent ?? '';
    // The *racing* number, not the first one in the sentence — that one is how
    // many matched (401), which is true with or without a clamp.
    const raced = Number(/racing (\d+) of them/.exec(summary)?.[1] ?? '0');
    // Well past the car total, so this can only be satisfied by the clamp.
    expect(raced).toBe(100);
  });

  it('counts the vendor chip the way the run counts it', async () => {
    // Reported from a loaded extension: "National has 5 codes that have been
    // refused so won't be raced. So it is doing 14, though the check box next
    // to National still says 19."
    //
    // The same disagreement as before — the chip promising what the run will not
    // do — arriving because the plan learned to skip refused codes and
    // `countCodesFor` had not.
    savedRejected = ['XZ15J55', 'XZ45B65', 'XZ24R05', 'XZ24S06', 'XZ15CH7'].map((code) => ({
      vendor: 'national',
      code,
      at: 1,
    }));
    savedForm = { category: 'car', vendors: ['national'], companies: [] };
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const chip = [...document.querySelectorAll('#vendor-chips .chip')].find((el) =>
      (el.textContent ?? '').includes('National'),
    );
    expect(chip?.querySelector('.count')?.textContent).toBe('14');
    // The smaller number alone is its own confusion, so the chip carries the
    // difference rather than swallowing it.
    expect(chip?.getAttribute('title')).toMatch(/19 codes, 5 refused/);

    // And it agrees with the plan's own count of what is left to race. The cap
    // is a separate, visible truncation — "14 codes match … racing 12 of them" —
    // so the number to compare the chip against is the match, not the slice.
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/^14 codes match/);
    });
  });

  it('puts the chip count back when the refusals are cleared', async () => {
    // `refreshPlan` alone would leave the chip and the company list showing the
    // reduced numbers after the codes had been put back.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    savedForm = { category: 'car', vendors: ['national'], companies: [] };
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const count = () =>
      [...document.querySelectorAll('#vendor-chips .chip')]
        .find((el) => (el.textContent ?? '').includes('National'))
        ?.querySelector('.count')?.textContent;
    expect(count()).toBe('18');

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => expect(count()).toBe('19'));
  });

  it('stops racing a code the vendor has refused, and says it is doing so', async () => {
    // Racing a refused code costs a real tab on a real vendor site and can only
    // fail. National refuses several of the contract ids in the workbook.
    savedRejected = [
      { vendor: 'national', code: '5666666', at: 1 },
      { vendor: 'national', code: 'XZ15J55', at: 1 },
    ];
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const summary = () => document.querySelector('#plan-summary')?.textContent ?? '';
    await vi.waitFor(() => expect(summary()).toMatch(/Racing|codes match/));
    // Named, not silent: a code that vanishes with no explanation is
    // indistinguishable from one the database never had.
    expect(summary()).toMatch(/2 refused codes are being skipped/);
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#rejected-count')?.textContent).toMatch(/2 codes have been/);
  });

  it('puts refused codes back when asked to try them again', async () => {
    // The undo half. A cache of somebody else's answer that cannot be dropped is
    // a permanent, invisible edit to the user's own code list.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    await vi.waitFor(() =>
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/1 refused code is/),
    );

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(/refused/);
    });
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
  });

  it('reloads refused codes when a run finishes, so the next Run skips them', async () => {
    // The popup usually stays open across a run. Loaded once at boot,
    // `ui.rejected` would still be empty afterwards and pressing Run again
    // would re-race codes the vendor refused a moment ago — a real tab spent
    // rediscovering a refusal, which is the one thing this feature avoids.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    expect(document.querySelector('#plan-summary')?.textContent ?? '').not.toMatch(/refused/);

    // What the background would have written while the run was in flight.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (i: unknown) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      rejectedCodes: [{ vendor: 'national', code: '5666666', at: 1 }],
    });
    await broadcastFinishedRun();

    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/1 refused code is/);
    });
  });

  it('keeps the recovery button reachable when every code has been refused', async () => {
    // The one state that needs "try them again" was the one that hid it:
    // `renderRejectedNote` ran only on refreshPlan's success path, and an
    // all-refused selection returns early.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    savedForm = {
      category: 'car',
      vendors: ['national'],
      companies: ['ibm'],
    };
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/No codes left to race/);
    });
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(false);
  });

  it('says the vendors refused everything, rather than "pick a vendor"', async () => {
    // Two filters can empty the company list, and until this branch existed the
    // message named the wrong one. Select only National, let its codes be
    // refused over a few runs, and the plan line correctly said every code was
    // refused while the list below told the user to pick a vendor they had
    // already picked — pointing away from the one control that fixes it.
    const { allCompanies, codeReaches } = await import('../src/core/codes.js');
    savedRejected = allCompanies()
      .flatMap((company) => company.codes)
      .filter((record) => record.code && codeReaches(record.vendor, 'national'))
      .map((record) => ({ vendor: 'national', code: record.code!, at: 1 }));
    expect(savedRejected.length).toBeGreaterThan(0);
    savedForm = { category: 'car', vendors: ['national'], companies: [] };
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const empty = () => document.querySelector('#company-list .empty:not(.selection)')?.textContent;
    await vi.waitFor(() => expect(empty()).toBeTruthy());
    expect(empty()).toMatch(/refused by the vendor/);
    // And names the undo, which is two lines below the list.
    expect(empty()).toMatch(/try them again/);
    expect(empty()).not.toMatch(/Pick at least one vendor/);
  });

  it('still says "pick a vendor" when that is really the problem', async () => {
    // The other half, and the reason the new branch tests reachability rather
    // than just "the list is empty": a genuinely empty selection must keep the
    // message that names the control it is about.
    savedForm = { category: 'car', vendors: [], companies: [] };
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    // Nothing selected in storage means the popup fills it in, so untick by
    // hand — the state only a user can reach.
    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if (box.checked) box.click();
    }
    document
      .querySelector<HTMLInputElement>('#company-search')
      ?.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('#company-list .empty:not(.selection)')?.textContent).toMatch(
        /Pick at least one vendor/,
      );
    });
  });

  it('does not re-tick vendor chips the user has just cleared', async () => {
    // `renderVendorChips` used to fill an empty selection itself, which was
    // right while `setCategory` was its only caller. It is now also called when
    // the refusal set changes — so unticking every chip and then clearing the
    // refusals silently re-ticked the whole row, reverting a choice the user had
    // just made and leaving `ui.vendors` disagreeing with the saved form.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('#vendor-chips input')];
    expect(boxes().length).toBeGreaterThan(0);
    for (const box of boxes()) {
      if (box.checked) box.click();
    }
    expect(boxes().every((box) => !box.checked)).toBe(true);

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
    expect(boxes().every((box) => !box.checked)).toBe(true);
  });

  it('leaves the company list alone when a run refuses nothing', async () => {
    // Both renders are a full `replaceChildren`, and a run finishes
    // asynchronously with whatever the user is doing: rebuilding the list under
    // someone mid-click resets their scroll and drops their focus. Most runs
    // refuse nothing, so the rebuild is gated on the news actually changing.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const row = () => document.querySelector('#company-list label');
    const before = row();
    expect(before).not.toBeNull();

    await broadcastFinishedRun();
    // Node identity, because that is precisely what a click, a focus and a
    // scroll position are attached to.
    expect(row()).toBe(before);

    // The converse: news that does change the counts still redraws them.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (i: unknown) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      rejectedCodes: [{ vendor: 'national', code: '5666666', at: 1 }],
    });
    await broadcastFinishedRun();
    await vi.waitFor(() => expect(row()).not.toBe(before));
  });

  it('labels a company with a vendor it only reaches through alsoTryAs', async () => {
    // Reported from a loaded extension: "the codes-to-race list doesn't have
    // any that say National. It has ones that say avis or hertz or sixt and
    // some that are blank."
    //
    // Both halves on one line. `vendors.includes(c.vendor)` is the exact-match
    // rule that has now been wrong in four places — every National code is
    // filed under Enterprise, so National could never appear — and the blanks
    // were the previous half-fix's own fault: correcting the *filter* let those
    // companies into the list while this line still asked the old question, so
    // they matched and had nothing to show. The ids were raw, too.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    const rows = [...document.querySelectorAll('#company-list .company')];
    const labels = rows.map((row) => row.querySelector('.vendors')?.textContent ?? '');

    // No row that made it into the list may be blank: being listed means at
    // least one selected vendor can race one of its codes.
    expect(labels.filter((text) => text.trim() === '')).toHaveLength(0);
    // Labels, not internal ids.
    expect(labels.join(' ')).not.toMatch(/\bnational\b/);
    expect(labels.some((text) => text.includes('National'))).toBe(true);
  });

  it('drops a saved vendor that can no longer be searched', async () => {
    // What an upgrading user has in chrome.storage from before Budget,
    // Enterprise and National became unsearchable. restoreForm filtered against
    // every vendor id rather than the searchable ones, so those three survived
    // in ui.vendors permanently — re-persisted on the next save, with no chip
    // anywhere to untick.
    //
    // Not cosmetic: renderCompanyList filters on the raw set, so the list grew
    // to 37 rows from 25 and labelled companies with vendors that cannot be
    // raced; an Enterprise-only company could be ticked and then reported "No
    // codes match this selection." with nothing explaining why. Same
    // promise-what-cannot-run defect as the one marking them unsearchable
    // removed, arriving through storage instead of through the chips.
    savedForm = {
      category: 'car',
      vendors: ['hertz', 'avis', 'budget', 'enterprise', 'national', 'sixt'],
      companies: [],
    };
    // Re-installed: beforeEach built the fake storage before this test could
    // seed it, so the popup would have booted against an empty store.
    installChrome();
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();

    // Read the `.vendors` span rather than the whole row: company *names*
    // contain these words ("Nationwide" contains "national"), so matching row
    // text fails for a reason that has nothing to do with the bug.
    const listed = new Set(
      [...document.querySelectorAll('.company .vendors')].flatMap((el) =>
        (el.textContent ?? '').split(' · ').filter(Boolean),
      ),
    );
    expect(listed.size).toBeGreaterThan(0);
    // Labels now, not raw ids — and National belongs here: it is searchable via
    // its driver, so a saved selection naming it survives. Budget and
    // Enterprise are what must not, which is the invariant this test is for.
    // Sixt joins Budget and Enterprise here: its deep link reaches no search,
    // so a saved selection naming it must not survive either.
    expect([...listed].sort()).toEqual(['Avis', 'Hertz', 'National']);
  });

  it('refuses a location that is not an airport code, before opening any tab', async () => {
    // Load-bearing, and unpinned until now. Both verified builders take an IATA
    // code and nothing else, so "Chicago Downtown" makes Avis and Hertz throw
    // link-build — leaving the race to be decided *only* by the vendors that
    // cannot reach a search, whose home pages answer with a "from $19/day" that
    // wins. Rejecting here is the difference between no answer and a
    // confidently wrong one, so it has to happen before START_RUN is sent.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    const set = (name: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (field) field.value = value;
    };
    set('pickupLocation', 'Chicago Downtown');
    set('pickupDate', '2026-09-04');
    set('dropoffDate', '2026-09-11');
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();

    expect(sentMessages.filter((m) => m.type === 'START_RUN')).toHaveLength(0);
    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/airport code/i);
  });

  it('opens a real Avis availability page for the bot check, dated ahead', async () => {
    // The button is a session chore, not a search: it must work with the form
    // empty, which is exactly when someone reaches for it. Dates are computed
    // from today so it cannot start asking for a date in the past, and it
    // carries no discount code because the point is to reach the page that
    // shows the check, not to price anything.
    const opened: Array<{ url?: string; active?: boolean }> = [];
    (globalThis as { chrome?: Record<string, unknown> }).chrome!.tabs = {
      create: (options: { url?: string; active?: boolean }) => {
        opened.push(options);
        return Promise.resolve({ id: 1 });
      },
    };
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    document.querySelector<HTMLButtonElement>('#avis-captcha-btn')?.click();

    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!.url!);
    expect(url.host).toBe('www.avis.com');
    expect(url.pathname).toBe('/en/reservation/vehicle-availability');
    // Focused and visible — the user has to interact with it, unlike a probe tab.
    expect(opened[0]!.active).toBe(true);
    // No code: withParams drops empty values.
    expect(url.searchParams.get('awd_number')).toBeNull();
    // Dated ahead of today, which is the part that stops it rotting.
    const asked = new Date(
      Number(url.searchParams.get('pickup_year')),
      Number(url.searchParams.get('pickup_month')) - 1,
      Number(url.searchParams.get('pickup_day')),
    );
    expect(asked.getTime()).toBeGreaterThan(Date.now());
  });

  it('says so when the bot-check tab cannot be opened', async () => {
    // The whole point of the button is that the user then goes and does
    // something in that tab. A button that silently does nothing sends them to
    // wait at a page that never opened, so the failure has to be visible — and
    // it was deletable with the suite green.
    (globalThis as { chrome?: Record<string, unknown> }).chrome!.tabs = {
      create: () => Promise.reject(new Error('no window')),
    };
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    document.querySelector<HTMLButtonElement>('#avis-captcha-btn')?.click();
    await Promise.resolve();

    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/bot check/i);
    expect(document.querySelector('#plan-summary')?.classList.contains('is-warning')).toBe(true);
  });

  it('opens one focused Budget tab for the bot check, and no search', async () => {
    const opened: Array<{ url?: string; active?: boolean }> = [];
    (globalThis as { chrome?: Record<string, unknown> }).chrome!.tabs = {
      create: (options: { url?: string; active?: boolean }) => {
        opened.push(options);
        return Promise.resolve({ id: 1 });
      },
    };
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    document.querySelector<HTMLButtonElement>('#budget-captcha-btn')?.click();

    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!.url!);
    expect(url.host).toBe('www.budget.com');
    // Focused and visible — the user has to interact with it, unlike a probe tab.
    expect(opened[0]!.active).toBe(true);
    // No code and no itinerary. Unlike Avis this cannot carry one — Budget's
    // builder throws by design — and it must not start looking like a search.
    expect(url.search).toBe('');
  });

  it('says so when the Budget bot-check tab cannot be opened', async () => {
    // Same reasoning as the Avis case: the button's whole purpose is to send
    // the user somewhere, so a failure that says nothing leaves them waiting at
    // a tab that never opened.
    (globalThis as { chrome?: Record<string, unknown> }).chrome!.tabs = {
      create: () => Promise.reject(new Error('no window')),
    };
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    document.querySelector<HTMLButtonElement>('#budget-captcha-btn')?.click();
    await Promise.resolve();

    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Budget bot check/i);
    expect(document.querySelector('#plan-summary')?.classList.contains('is-warning')).toBe(true);
  });

  it('refuses a time that is not hh:mm', async () => {
    // Unreachable through the form today — the inputs carry no `step`, so
    // Chrome emits hh:mm — but adding one makes Chrome emit hh:mm:ss, which
    // both verified builders reject. Without this the failure is two
    // `link-build`s and a race decided by a vendor that reaches no search.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    fillCarForm();
    const time = document.querySelector<HTMLInputElement>('[name="pickupTime"]');
    if (time) time.value = '10:00:00';
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();

    expect(sentMessages.filter((m) => m.type === 'START_RUN')).toHaveLength(0);
    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/hh:mm/i);
  });

  it('refuses a drop-off that differs from the pick-up', async () => {
    // One-way is refused in the builders because Avis's return-location
    // parameter proved unreliable; catching it here means the user is told,
    // rather than every car quote failing as link-build.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    fillCarForm();
    const dropoff = document.querySelector<HTMLInputElement>('[name="dropoffLocation"]');
    if (dropoff) dropoff.value = 'MCO';
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();

    expect(sentMessages.filter((m) => m.type === 'START_RUN')).toHaveLength(0);
    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/one-way/i);
  });

  it('accepts a lowercase code and a drop-off equal to the pick-up', async () => {
    // The guard must not be so strict that it rejects the same airport spelled
    // differently — that would refuse a perfectly ordinary round trip.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    fillCarForm();
    const pickup = document.querySelector<HTMLInputElement>('[name="pickupLocation"]');
    const dropoff = document.querySelector<HTMLInputElement>('[name="dropoffLocation"]');
    if (pickup) pickup.value = 'tpa';
    if (dropoff) dropoff.value = ' TPA ';
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();

    expect(sentMessages.filter((m) => m.type === 'START_RUN')).toHaveLength(1);
  });

  /** Push a finished run into the popup and return the caveat line's text. */
  async function caveatFor(quotes: unknown[]): Promise<string> {
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    await boot();
    expect(broadcastListeners.length).toBeGreaterThan(0);
    for (const listen of broadcastListeners) {
      listen({
        type: 'RUN_STATE',
        state: {
          startedAt: 1,
          finishedAt: 2,
          plan: {
            trip: {
              category: 'car',
              pickupLocation: 'TPA',
              dropoffLocation: '',
              pickupDate: '2026-09-04',
              pickupTime: '10:00',
              dropoffDate: '2026-09-11',
              dropoffTime: '10:00',
            },
            candidates: [],
            concurrency: 2,
          },
          quotes,
        },
      });
    }
    const notes = [...document.querySelectorAll('#quotes .hint')].map((el) => el.textContent ?? '');
    return notes.join(' | ');
  }

  const quote = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'hertz:H1',
    candidate: {
      companySlug: 'acme',
      companyName: 'Acme',
      vendor: 'hertz',
      code: 'H1',
      note: null,
    },
    url: 'https://www.hertz.com/us/en/book/vehicles',
    confidence: 'verified',
    status: 'ok',
    offers: [{ label: 'Compact', amount: 200, currency: 'USD', basis: 'total' }],
    best: { label: 'Compact', amount: 200, currency: 'USD', basis: 'total' },
    startedAt: 1,
    finishedAt: 2,
    ...over,
  });

  it('explains a home-page landing as such, not as a currency mismatch', async () => {
    // The sentence for unranked quotes can only talk about basis and currency,
    // and a quote that landed on the vendor's home page is normally in the same
    // basis and currency as the winner. Sharing one sentence printed "quoted
    // daily rates in USD" as the reason a code was set aside from a bucket that
    // *is* daily rates in USD — a diagnosis known to be the wrong one, which
    // the row-level warning already contradicts.
    const winner = quote({
      id: 'hertz:H1',
      best: { label: 'Economy', amount: 60, currency: 'USD', basis: 'per-day' },
      offers: [{ label: 'Economy', amount: 60, currency: 'USD', basis: 'per-day' }],
    });
    const runnerUp = quote({
      id: 'avis:A1',
      best: { label: 'Economy', amount: 100, currency: 'USD', basis: 'per-day' },
      offers: [{ label: 'Economy', amount: 100, currency: 'USD', basis: 'per-day' }],
    });
    const homePage = quote({
      id: 'sixt:S1',
      suspect: 'landed-elsewhere',
      best: { label: 'Economy', amount: 35, currency: 'USD', basis: 'per-day' },
      offers: [{ label: 'Economy', amount: 35, currency: 'USD', basis: 'per-day' }],
    });
    await caveatFor([winner, runnerUp, homePage]);

    const box = document.querySelector('#savings')?.textContent ?? '';
    expect(box).toMatch(/home page/i);
    expect(box).not.toMatch(/1 other code quoted daily rates/i);
  });

  it('still shows the summary when a suspect quote is the only thing to explain', async () => {
    // `savingsBox.hidden` had to learn about the second reason too, and nothing
    // pinned that half: the sibling test above has a spread, so `!spread`
    // short-circuits before the counts are consulted. One real quote and one
    // suspect quote share no bucket pair, so there is no spread — and hiding
    // the box would take the only sentence explaining why nothing was ranked
    // with it, leaving a $35 row and no summary at all.
    const winner = quote({
      id: 'hertz:H1',
      best: { label: 'Economy', amount: 60, currency: 'USD', basis: 'per-day' },
      offers: [{ label: 'Economy', amount: 60, currency: 'USD', basis: 'per-day' }],
    });
    const homePage = quote({
      id: 'sixt:S1',
      suspect: 'landed-elsewhere',
      best: { label: 'Economy', amount: 35, currency: 'USD', basis: 'per-day' },
      offers: [{ label: 'Economy', amount: 35, currency: 'USD', basis: 'per-day' }],
    });
    await caveatFor([winner, homePage]);

    const box = document.querySelector<HTMLElement>('#savings');
    expect(box?.hidden).toBe(false);
    expect(box?.textContent ?? '').toMatch(/home page/i);
  });

  it('always says something about the links, even when all are verified', async () => {
    // The whole block was deletable with the suite green, including the branch
    // this PR added: it used to be `if (unverified > 0)`, so a run of only
    // verified vendors printed no caveat at all — and silence reads as a much
    // stronger promise than "checked on one US airport round trip".
    const text = await caveatFor([quote({}), quote({ id: 'avis:A1', confidence: 'verified' })]);
    expect(text).toMatch(/US airport round-trips only/i);
  });

  it('does not count a link it never built as an unverified link', async () => {
    // link-build quotes are stamped `best-effort` by the worker's catch path,
    // so counting them announced "N of these search links are unverified"
    // about links that were never built, let alone followed.
    const text = await caveatFor([
      quote({}),
      quote({ id: 'sixt:S1', confidence: 'best-effort', status: 'error', failure: 'link-build' }),
    ]);
    expect(text).not.toMatch(/1 of these search links/i);
    expect(text).toMatch(/US airport round-trips only/i);
  });

  it('says plainly when nothing could be turned into a search', async () => {
    const text = await caveatFor([
      quote({ confidence: 'best-effort', status: 'error', failure: 'link-build' }),
    ]);
    expect(text).toMatch(/could be turned into a search/i);
  });

  it('sends one START_RUN for a double-click, not two', async () => {
    // `ui.running` only becomes true once the background answers, so between
    // the click and the reply `runBtn.disabled` was false — and the next
    // refreshPlan re-armed it anyway. A double-click sent two START_RUNs, and
    // the worker built two runs: two minimised windows, twice the cap, twice
    // the load on every vendor. `ui.pendingStart` is set synchronously on
    // submit for exactly this window.
    //
    // Deleting `|| ui.pendingStart` from refreshPlan and `ui.pendingStart =
    // false` from renderRun left the whole suite green before this test.
    let release: (value: unknown) => void = () => {};
    sendMessageImpl = (message) =>
      message.type === 'START_RUN'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ type: 'RUN_STATE', state: null });

    await boot();
    fillCarForm();

    // Clicked, not dispatched as a synthetic `submit`: the guard works by
    // disabling the button, and a synthetic submit event bypasses exactly the
    // thing being tested. Two real clicks is the reported reproduction.
    const runBtn = document.querySelector<HTMLButtonElement>('#run-btn');
    runBtn?.click();
    runBtn?.click();

    expect(sentMessages.filter((m) => m.type === 'START_RUN')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(true);
    release({ type: 'RUN_STATE', state: null });
  });

  it('keeps Run disabled through a refreshPlan while the start is in flight', async () => {
    // The regression this guards: `ui.running` is still false, so a vendor chip
    // or a max-codes keystroke re-armed the button mid-flight. That is the
    // window the second click of a double-click went through.
    let release: (value: unknown) => void = () => {};
    sendMessageImpl = (message) =>
      message.type === 'START_RUN'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ type: 'RUN_STATE', state: null });

    await boot();
    fillCarForm();
    document
      .querySelector<HTMLFormElement>('#trip-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes');
    if (maxCodes) {
      maxCodes.value = '8';
      maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    }

    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(true);
    release({ type: 'RUN_STATE', state: null });
  });

  it('re-arms the button once the background answers', async () => {
    // The other side of the guard. `ui.pendingStart` is cleared by renderRun,
    // and without that the flag latches: the first submit disables Run forever,
    // because every later refreshPlan keeps reading a start that is no longer
    // in flight. A run that finished would leave the user unable to start
    // another without reopening the popup.
    await boot();
    fillCarForm();
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(false);
    });

    // And it stays armed through a refreshPlan, which is where a latched flag
    // would show up.
    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes');
    if (maxCodes) {
      maxCodes.value = '7';
      maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(false);
  });
});

describe('a START_RUN the background never received', () => {
  async function bootWithFailingStart(): Promise<void> {
    sendMessageImpl = (message) =>
      message.type === 'START_RUN'
        ? Promise.reject(new Error('Receiving end does not exist.'))
        : Promise.resolve({ type: 'RUN_STATE', state: null });
    await import('../src/popup/popup.js');
    await vi.waitFor(() => {
      expect(document.querySelector('#tagline')?.textContent).toMatch(/corporate codes loaded/);
    });
    const set = (name: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (field) field.value = value;
    };
    set('pickupLocation', 'TPA');
    set('pickupDate', '2026-09-04');
    set('dropoffDate', '2026-09-11');
    document
      .querySelector<HTMLFormElement>('#trip-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
    });
  }

  it('keeps the explanation after a refreshPlan overwrites the plan line', async () => {
    // The button correctly stays dead — a rejection does not prove
    // non-delivery, so re-arming offers a second race on top of one that may
    // already be opening tabs. But every refreshPlan trigger overwrote the
    // plan line and cleared `is-warning`, leaving a dead button and no reason
    // for it. `ui.sendFailed` is sticky so refreshPlan puts it back.
    await bootWithFailingStart();

    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes');
    if (maxCodes) {
      maxCodes.value = '9';
      maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    }

    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
    expect(document.querySelector('#plan-summary')?.classList.contains('is-warning')).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(true);
  });

  it('says on the button itself what to do about it', async () => {
    // The plan line is the first thing a keystroke overwrites, and the button
    // is the thing being clicked, so the recovery belongs there too.
    await bootWithFailingStart();
    expect(document.querySelector('#run-btn')?.textContent).toMatch(/Reopen the popup/);
  });
});

describe('a rejection that did not mean non-delivery', () => {
  it('recovers when the background broadcasts a run it did receive', async () => {
    // The whole reason the popup refuses to re-arm on a failed send is that a
    // rejection does not prove the message was not delivered. When it *was*
    // delivered, the worker starts the run and broadcasts RUN_STATE — and that
    // broadcast is the popup's proof, so it has to clear `sendFailed` and stop
    // telling the user to reopen. Without that the popup sits on "Reopen the
    // popup to retry" while the race it started runs behind it.
    sendMessageImpl = (message) =>
      message.type === 'START_RUN'
        ? Promise.reject(new Error('Receiving end does not exist.'))
        : Promise.resolve({ type: 'RUN_STATE', state: null });
    await import('../src/popup/popup.js');
    await vi.waitFor(() => {
      expect(document.querySelector('#tagline')?.textContent).toMatch(/corporate codes loaded/);
    });
    const set = (name: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (field) field.value = value;
    };
    set('pickupLocation', 'TPA');
    set('pickupDate', '2026-09-04');
    set('dropoffDate', '2026-09-11');
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
    });

    // The worker did get it, and says so.
    expect(broadcastListeners.length).toBeGreaterThan(0);
    for (const listen of broadcastListeners) {
      listen({
        type: 'RUN_STATE',
        state: {
          startedAt: 1,
          finishedAt: null,
          plan: {
            trip: {
              category: 'car',
              pickupLocation: 'TPA',
              dropoffLocation: '',
              pickupDate: '2026-09-04',
              pickupTime: '10:00',
              dropoffDate: '2026-09-11',
              dropoffTime: '10:00',
            },
            candidates: [],
            concurrency: 2,
          },
          quotes: [],
        },
      });
    }

    expect(document.querySelector('#run-btn')?.textContent).not.toMatch(/Reopen the popup/);

    // And a later refreshPlan must not put the stale message back.
    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes');
    if (maxCodes) {
      maxCodes.value = '6';
      maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(/Could not reach/);
  });
});
