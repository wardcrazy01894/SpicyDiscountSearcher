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
/**
 * A background that answers the way the real one does.
 *
 * `CLEAR_REJECTED` has to actually clear, because the popup no longer writes
 * that key itself — it asks the worker to, so both writers share one realm and
 * one write queue. A stub that only replied would leave the popup re-reading a
 * list nothing had emptied.
 */
function fakeBackground(message: { type: string }): Promise<unknown> {
  if (message.type === 'CLEAR_REJECTED') {
    const { local } = (
      globalThis as {
        chrome: { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage;
    return local.set({ rejectedCodes: [] }).then(() => ({ type: 'RUN_STATE', state: null }));
  }
  return Promise.resolve({ type: 'RUN_STATE', state: null });
}

/** Swapped by a test to make START_RUN reject the way a dead worker does. */
let sendMessageImpl: (message: { type: string }) => Promise<unknown> = fakeBackground;

/** The plan a finished-run broadcast carries; its contents do not matter here. */
const PLAN = {
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
};

/** Seeded into chrome.storage.local before the popup boots. */
let savedForm: Record<string, unknown> | null = null;
/** Codes a vendor has already refused, as the background would have stored them. */
let savedRejected: Array<{ vendor: string; code: string; at: number }> | null = null;

/**
 * How long *boot's* storage reads take.
 *
 * Zero for every test but one. `main()` is a chain of awaited reads, so slowing
 * them is what holds open the window between the module registering its
 * RUN_STATE listener and boot having a selection to draw. Only the first two —
 * the ones `main` itself awaits — so a broadcast arriving inside that window
 * gets a *fast* read and renders promptly, which is what puts the assertion
 * safely between the two events rather than guessing at a gap.
 */
let getDelayMs = 0;
let slowReadsLeft = 0;

/** The slice of chrome the popup touches while starting up. */
function installChrome(): void {
  const local = new Map<string, unknown>();
  if (savedForm) local.set('popupForm', savedForm);
  if (savedRejected) local.set('rejectedCodes', savedRejected);
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: () => {
          const slow = slowReadsLeft > 0;
          if (slow) slowReadsLeft -= 1;
          // Snapshot when the read is *issued*, not when it resolves — which is
          // what `chrome.storage.get` does, and the whole difference between a
          // slow read and a stale one. Resolving with the map's later contents
          // made a delayed read silently pick up writes that happened after it,
          // so a test for "the stale read must not win" had no stale read in it
          // and passed against the bug.
          const snapshot = Object.fromEntries(local);
          return slow
            ? new Promise((resolve) => setTimeout(() => resolve(snapshot), getDelayMs))
            : Promise.resolve(snapshot);
        },
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
  getDelayMs = 0;
  slowReadsLeft = 0;
  sendMessageImpl = fakeBackground;
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

  it('says the run is starting, rather than going quiet', async () => {
    // `beginRun` awaits `cancelRun`, which waits on the previous run's
    // outstanding refusal writes — so this reply is not prompt, and a disabled
    // button with its ordinary label, no tabs opening and no "Racing codes…" is
    // indistinguishable from a dead extension. Same answer the clear button
    // gives with "clearing…".
    let answer: (() => void) | undefined;
    sendMessageImpl = (message) => {
      if (message.type === 'START_RUN') {
        return new Promise((resolve) => {
          answer = () => resolve({ type: 'RUN_STATE', state: null });
        });
      }
      return fakeBackground(message);
    };
    await boot();
    fillCarForm();

    const run = () => document.querySelector<HTMLButtonElement>('#run-btn')!;
    run().click();
    expect(run().disabled).toBe(true);
    expect(run().textContent).toBe('Starting…');

    answer?.();
    await vi.waitFor(() => expect(run().textContent).toBe('Find the cheapest code'));
  });

  it('offers a codes cap high enough to race every car code, and enforces it', async () => {
    // 100 covers all 66 car candidates, so a car run can be exhaustive. The
    // number matters because nothing ranks the codes — `interleaveByVendor`
    // makes truncation *fair*, not *good*, so whatever the cap cuts is cut
    // arbitrarily.
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
    await boot();

    const chip = [...document.querySelectorAll('#vendor-chips .chip')].find((el) =>
      (el.textContent ?? '').includes('National'),
    );
    expect(chip?.querySelector('.count')?.textContent).toBe('14');
    // The smaller number alone is its own confusion, so the chip carries the
    // difference rather than swallowing it — and says it through `aria-label`
    // too, since a `title` needs a hovering mouse and the whole point is that
    // a bare "14" explains nothing.
    expect(chip?.getAttribute('title')).toMatch(/19 codes at National.*5 refused/);
    expect(chip?.getAttribute('aria-label')).toBe(chip?.getAttribute('title'));
    // And names what it counts: a per-vendor total across every company, which
    // is not the plan's number once a company is ticked.
    expect(chip?.getAttribute('title')).toMatch(/across every company/);

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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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

  it('asks the background to clear rather than writing storage itself', async () => {
    // The popup and the service worker are different realms with their own
    // module state, so the write queue in `rejected-codes.ts` cannot order a
    // clear written from this side against a `recordRejected` the worker
    // already has in flight: the clear lands between that record's read and its
    // write and is undone by it, and every refusal the user asked to forget
    // comes back. Invisibly, because this side has already emptied its own copy
    // — it only shows on the next open.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = fakeBackground;
    await boot();

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(sentMessages.map((message) => message.type)).toContain('CLEAR_REJECTED');
    });
  });

  it('says so beside the button, without hiding what the run will do', async () => {
    // Storage decides, not the reply. Here the send fails *and* the codes are
    // still there, so the button really did nothing and saying nothing would
    // leave the note on screen with no explanation.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    sendMessageImpl = () => Promise.reject(new Error('worker is gone'));

    const note = () => document.querySelector('#rejected-note')?.textContent ?? '';
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => expect(note()).toMatch(/not been cleared yet/));
    // Styled as a warning, and `hint is-warning` rather than `is-warning`: the
    // stylesheet has no bare rule, so on its own the class matched nothing and
    // the warning rendered in the same muted grey as the count beside it. Every
    // other assertion here is on `textContent`, which is exactly why nothing
    // caught that.
    const warning = document.querySelector('#rejected-note span.is-warning');
    expect(warning?.classList.contains('hint')).toBe(true);
    // Beside the "try them again" button, which is still there because the
    // codes really are still refused.
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(false);

    // And the plan line still says what the run will do. It lived there for one
    // round and *replaced* that text wholesale, so the truncation warning —
    // which CLAUDE.md calls out as the thing that must never be silent — and
    // the skipped-codes note were invisible for as long as the flag was set.
    const plan = () => document.querySelector('#plan-summary')?.textContent ?? '';
    expect(plan()).toMatch(/codes match|Racing/);
    expect(plan()).not.toMatch(/not been cleared yet/);

    // Survives the refreshPlan triggers that wiped it when it was a one-off
    // write: a max-codes keystroke, a chip, a checkbox.
    const maxCodes = document.querySelector<HTMLInputElement>('#max-codes')!;
    maxCodes.value = '30';
    maxCodes.dispatchEvent(new Event('input', { bubbles: true }));
    expect(note()).toMatch(/not been cleared yet/);
    expect(plan()).toMatch(/codes match|Racing/);

    // And it goes away when a clear actually works — no reset needed, because
    // the note it lives in hides once nothing is refused.
    sendMessageImpl = fakeBackground;
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
    expect(note()).not.toMatch(/not been cleared yet/);
  });

  it('updates the refused note even when the popup could not reach the background at boot', async () => {
    // `refreshPlan` returns early on `ui.sendFailed`, which is set by a failed
    // GET_STATE at boot and cleared only by `renderRun` — which the clear path
    // never calls. So a clear that *worked* left the note still reading "N
    // codes have been refused" with the chips beside it already restored. It is
    // the second early return to have stranded this note; the first was the
    // all-refused branch.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = () => Promise.reject(new Error('worker is asleep'));
    await boot();
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
    });
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(false);

    // The worker wakes up for the clear even though GET_STATE never landed.
    sendMessageImpl = fakeBackground;
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
  });

  it('keeps a ticked company listed once all its codes are refused', async () => {
    // The filter drops a company whose every reachable code has been refused,
    // but the slug stays in `ui.companies` and in the saved form — so the row
    // vanished while the plan line read "No codes left to race", with no
    // checkbox left to untick it. The only escapes were the blanket `clear`,
    // which drops every company, or restoring all the refusals.
    const { allCompanies, codeReaches } = await import('../src/core/codes.js');
    const ibm = allCompanies().find((company) => company.slug === 'ibm')!;
    savedRejected = ibm.codes
      .filter((record) => record.code && codeReaches(record.vendor, 'national'))
      .map((record) => ({ vendor: 'national', code: record.code!, at: 1 }));
    expect(savedRejected.length).toBeGreaterThan(0);
    savedForm = { category: 'car', vendors: ['national'], companies: ['ibm'] };
    installChrome();
    await boot();

    const rows = () => [...document.querySelectorAll('#company-list label.company')];
    const ibmRow = () => rows().find((row) => (row.textContent ?? '').includes(ibm.name));
    await vi.waitFor(() => expect(ibmRow()).toBeDefined());
    // Listed, tickable — and saying why rather than rendering the blank vendor
    // list that a half-fix to this filter produced once before.
    expect(ibmRow()?.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    expect(ibmRow()?.querySelector('.vendors')?.textContent).toBe('all refused');
  });

  it('says why a ticked company has nothing to race, rather than assuming', async () => {
    // The escape-hatch row above was kept for *any* reason, then labelled
    // `all refused` unconditionally — so a company that simply has no code at
    // the remaining vendors was blamed on refusals, with an empty store. The
    // two cases want opposite actions: put the refusals back, or pick another
    // vendor.
    savedForm = { category: 'car', vendors: ['hertz', 'avis'], companies: [] };
    installChrome();
    await boot();

    // Tick the first company that reaches Avis and not Hertz, then untick Avis.
    const { allCompanies, codeReaches } = await import('../src/core/codes.js');
    const avisOnly = allCompanies().find(
      (company) =>
        company.codes.some((c) => c.code && codeReaches(c.vendor, 'avis')) &&
        !company.codes.some((c) => c.code && codeReaches(c.vendor, 'hertz')),
    )!;
    const rowFor = (name: string) =>
      [...document.querySelectorAll('#company-list label.company')].find((row) =>
        (row.textContent ?? '').includes(name),
      );
    const search = document.querySelector<HTMLInputElement>('#company-search')!;
    search.value = avisOnly.name;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    rowFor(avisOnly.name)?.querySelector<HTMLInputElement>('input')?.click();

    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if ((box.closest('label')?.textContent ?? '').includes('Avis') && box.checked) box.click();
    }

    // Still listed, so it can be unticked — and honest about why.
    expect(rowFor(avisOnly.name)?.querySelector('.vendors')?.textContent).toBe(
      'no code at these vendors',
    );
  });

  it('still says to pick a vendor when a ticked company is all that is listed', async () => {
    // Folding the stranded row into `matches` suppressed the empty-list branch
    // entirely: with a company ticked and every chip unticked, the list showed
    // one unraceable row and never said `Pick at least one vendor`, which was
    // exactly the diagnosis.
    savedForm = { category: 'car', vendors: ['national'], companies: ['ibm'] };
    installChrome();
    await boot();

    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if (box.checked) box.click();
    }

    const list = () => document.querySelector('#company-list')?.textContent ?? '';
    expect(list()).toMatch(/Pick at least one vendor/);
    // And the row is still there to untick.
    expect(document.querySelectorAll('#company-list label.company').length).toBe(1);
  });

  it('keeps a stranded company listed even behind a full page of matches', async () => {
    // The escape hatch was appended *after* the matches and then sliced at 60,
    // so it existed only while there were fewer than 60 matches. Cars have 33,
    // which is why it looked fine; hotels have 146 at Hilton alone, so in that
    // category the row vanished — slug still in `ui.companies` and in the saved
    // form, and no checkbox anywhere to untick it.
    //
    // The scenario needs matches *and* a stranded row at once, which an earlier
    // version of this test did not have: unticking the only selected vendor
    // leaves no matches either, so the ordering it meant to pin made no
    // difference and the mutation survived.
    const { allCompanies } = await import('../src/core/codes.js');
    const has = (company: { codes: Array<{ code: string | null; vendor: string }> }, v: string) =>
      company.codes.some((code) => code.code && code.vendor === v);
    const marriottOnly = allCompanies().find(
      (company) => has(company, 'marriott') && !has(company, 'hilton'),
    )!;
    savedForm = { category: 'hotel', vendors: ['hilton', 'marriott'], companies: [] };
    installChrome();
    await boot();

    const rows = () => [...document.querySelectorAll('#company-list label.company')];
    const named = () => rows().map((row) => row.querySelector('span')?.textContent ?? '');
    const search = document.querySelector<HTMLInputElement>('#company-search')!;
    search.value = marriottOnly.name;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    rows()[0]?.querySelector<HTMLInputElement>('input')?.click();
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    // Untick Marriott. Hilton stays selected, so there are still 146 matches —
    // far more than the 60-row cap — and this company is stranded among them.
    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if ((box.closest('label')?.textContent ?? '').includes('Marriott') && box.checked) {
        box.click();
      }
    }

    expect(rows().length).toBe(60);
    expect(named()).toContain(marriottOnly.name);
  });

  it('counts the hidden rows against everything it meant to list', async () => {
    // The hint compared a *match* count against a length that also held
    // stranded rows, so it under-reported by exactly the number of stranded
    // rows on screen — and at 59 matches plus 5 stranded printed nothing at all
    // while four rows were dropped.
    const { allCompanies, codeReaches } = await import('../src/core/codes.js');
    const has = (company: { codes: Array<{ code: string | null; vendor: string }> }, v: string) =>
      company.codes.some((code) => code.code && code.vendor === v);
    const marriottOnly = allCompanies().find(
      (company) => has(company, 'marriott') && !has(company, 'hilton'),
    )!;
    savedForm = { category: 'hotel', vendors: ['hilton', 'marriott'], companies: [] };
    installChrome();
    await boot();

    const search = document.querySelector<HTMLInputElement>('#company-search')!;
    search.value = marriottOnly.name;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLInputElement>('#company-list label.company input')?.click();
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if ((box.closest('label')?.textContent ?? '').includes('Marriott') && box.checked) {
        box.click();
      }
    }

    const hint = document.querySelector('#company-list')?.textContent ?? '';
    const reported = Number(/\+(\d+) more/.exec(hint)?.[1]);
    const hiltonCompanies = allCompanies().filter((company) =>
      company.codes.some((code) => code.code && codeReaches(code.vendor, 'hilton')),
    ).length;
    // 146 matches + 1 stranded, 60 shown.
    expect(reported).toBe(hiltonCompanies + 1 - 60);
  });

  it('keeps saying a clear failed when the recheck finds it still has', async () => {
    // `reloadRejected` sets `ui.clearFailed = false` unconditionally, on the
    // stated understanding that its caller sets it again from what it read.
    // `recheckClear` was the one caller that did not — so six seconds after
    // correctly reporting a failure it read the same unchanged list and erased
    // the message, and a user who looked away saw no sign the button had done
    // nothing. The opposite of what the recheck is for.
    vi.useFakeTimers();
    try {
      savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
      installChrome();
      sendMessageImpl = () => Promise.reject(new Error('worker is gone'));
      await import('../src/popup/popup.js');
      await vi.advanceTimersByTimeAsync(50);

      document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
      await vi.advanceTimersByTimeAsync(500);
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);

      // Past the recheck. The clear still has not happened, so the message must
      // still be there.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the unreachable-background state on a clear the worker answered', async () => {
    // The clear path deliberately never calls `applyReply` — `renderRun(null)`
    // would hide a finished run's results — and in not doing so it never
    // retired `ui.sendFailed` either. So after a clear that demonstrably
    // reached the worker, the plan line still read "Could not reach the
    // extension background" with Run disabled, beside chips that had already
    // redrawn with the restored counts. A direct reply is stronger proof of
    // reachability than the broadcast that flag's own docstring accepts.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = () => Promise.reject(new Error('worker is asleep'));
    await boot();
    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
    });
    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(true);

    sendMessageImpl = fakeBackground;
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(/Could not reach/);
    });
    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/codes match|Racing/);
    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(false);
  });

  it('keeps saying a clear failed when a later run re-reads the list', async () => {
    // The third caller of `reloadRejected`, and the third time this flag was
    // erased by a reader that did not re-judge it. The clear handler owned the
    // judgement, then `recheckClear` did not, then it did and the RUN_STATE
    // listener still did not — so a run finishing after a failed clear removed
    // the warning while every code it named was still refused and still being
    // skipped. The flag is derived from (what was asked to clear, what is
    // stored) on every read now, so there is nothing left for a caller to
    // forget.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    sendMessageImpl = () => Promise.reject(new Error('worker is gone'));
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);
    });

    // A run finishes. Storage is unchanged — the clear never happened.
    sendMessageImpl = fakeBackground;
    await broadcastFinishedRun();

    const note = document.querySelector('#rejected-note')?.textContent ?? '';
    expect(note).toMatch(/1 code has been refused/);
    expect(note).toMatch(/not been cleared yet/);
  });

  it('does not call a clear failed when the code was re-refused before the read', async () => {
    // The variant the key-only rule missed. Press "try them again" during a
    // live run: the worker clears, a quote settles and records the same code
    // again — enqueued after the clear, so it is a new answer from the vendor —
    // and all of that lands before the popup's own read resolves. Judged on the
    // key alone that read sees a survivor and latches the failure permanently,
    // since the 31s recheck sees the same list. The stored `at` is what tells
    // the two apart.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = (message) => {
      if (message.type === 'CLEAR_REJECTED') {
        const { local } = (
          globalThis as {
            chrome: {
              storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } };
            };
          }
        ).chrome.storage;
        // Cleared, then re-refused by a quote settling a moment later.
        return local
          .set({ rejectedCodes: [{ vendor: 'national', code: '5666666', at: Date.now() + 5_000 }] })
          .then(() => ({ type: 'RUN_STATE', state: null }));
      }
      return fakeBackground(message);
    };
    await boot();

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    // Not `waitFor` on the count: it reads "1 code has been refused" before the
    // click too, so that condition is satisfied by the boot state and the
    // assertion below then runs before the clear has done anything — which is
    // how the first version of this passed against the bug.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector('#rejected-count')?.textContent).toMatch(/1 code has/);
    expect(document.querySelector('#rejected-note')?.textContent).not.toMatch(
      /not been cleared yet/,
    );
  });

  it('brings the next stranded rows in when one is unticked', async () => {
    // The cap on stranded rows is justified by "the next render brings the next
    // ten" — and nothing rendered on untick, so unticking all ten left them on
    // screen unchecked while the rest of the selection stayed invisible and
    // untickable. That is the trap stranded rows exist to avoid, moved from
    // "more than 60 matches" to "more than 10 stranded".
    const { allCompanies } = await import('../src/core/codes.js');
    const has = (company: { codes: Array<{ code: string | null; vendor: string }> }, v: string) =>
      company.codes.some((code) => code.code && code.vendor === v);
    const marriottOnly = allCompanies()
      .filter((company) => has(company, 'marriott') && !has(company, 'hilton'))
      .slice(0, 15);
    expect(marriottOnly.length).toBeGreaterThan(11);
    savedForm = {
      category: 'hotel',
      vendors: ['hilton'],
      companies: marriottOnly.map((company) => company.slug),
    };
    installChrome();
    await boot();

    const strandedRows = () =>
      [...document.querySelectorAll('#company-list label.company')].filter(
        (row) => row.querySelector('.vendors')?.textContent === 'no code at these vendors',
      );
    await vi.waitFor(() => expect(strandedRows().length).toBe(10));
    const before = strandedRows()
      .map((row) => row.querySelector('span')?.textContent ?? '')
      .join('|');

    strandedRows()[0]?.querySelector<HTMLInputElement>('input')?.click();

    // Still ten, and not the same ten: the eleventh has taken the free slot.
    expect(strandedRows().length).toBe(10);
    expect(
      strandedRows()
        .map((row) => row.querySelector('span')?.textContent ?? '')
        .join('|'),
    ).not.toBe(before);
  });

  it('keeps the keyboard on the list when a stranded row is unticked', async () => {
    // The re-render is a `replaceChildren`, so it detaches the very input being
    // dispatched to: focus falls back to `<body>` and the next Tab restarts
    // from the top of the popup. Unticking the ten stranded rows one after
    // another — the flow the cap's own justification assumes — then needs a
    // mouse.
    const { allCompanies } = await import('../src/core/codes.js');
    const has = (company: { codes: Array<{ code: string | null; vendor: string }> }, v: string) =>
      company.codes.some((code) => code.code && code.vendor === v);
    const marriottOnly = allCompanies()
      .filter((company) => has(company, 'marriott') && !has(company, 'hilton'))
      .slice(0, 15);
    savedForm = {
      category: 'hotel',
      vendors: ['hilton'],
      companies: marriottOnly.map((company) => company.slug),
    };
    installChrome();
    await boot();

    const inputs = () => [
      ...document.querySelectorAll<HTMLInputElement>('#company-list label.company input'),
    ];
    await vi.waitFor(() => expect(inputs().length).toBeGreaterThan(10));
    const first = inputs()[0]!;
    first.focus();
    expect(document.activeElement).toBe(first);
    first.click();

    // Focus is still in the list, on the row that took its place.
    expect(document.activeElement).not.toBe(document.body);
    expect(inputs()).toContain(document.activeElement);
  });

  it('does not call a clear failed while it is still out', async () => {
    // Until the worker has written there is nothing to read but the pre-clear
    // list, so a run finishing inside that window made the listener's read
    // report every attempted code as a survivor — rendering "Those codes have
    // not been cleared yet" beside a button still reading "clearing…". It
    // corrected itself when the clear's own read landed, but the message is the
    // one thing on screen that says the action did not work.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    let answer: (() => void) | undefined;
    sendMessageImpl = (message) => {
      if (message.type === 'CLEAR_REJECTED') {
        return new Promise((resolve) => {
          answer = () => void fakeBackground(message).then(resolve);
        });
      }
      return fakeBackground(message);
    };
    await boot();

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    // A run finishes while the clear is still out.
    for (const listener of broadcastListeners) {
      listener({ type: 'RUN_STATE', state: { plan: PLAN, quotes: [], finishedAt: 1 } });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector('#rejected-note')?.textContent).not.toMatch(
      /not been cleared yet/,
    );

    answer?.();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
  });

  it('disables "try them again" while the clear is in flight', async () => {
    // The worker's wait on the write chain can hold this reply for the length
    // of its ceiling, and nothing else here says anything is happening — half a
    // minute of silence is what produces repeat clicking. Each extra press
    // enqueues another link, raising the depth every later waiter sizes its own
    // bound from, and overwrites `clearAttempt`, so the first press's answer
    // would be judged against the last press's list. Same shape as the
    // synchronous latch on Run.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    let answer: (() => void) | undefined;
    sendMessageImpl = (message) => {
      if (message.type === 'CLEAR_REJECTED') {
        return new Promise((resolve) => {
          answer = () => void fakeBackground(message).then(resolve);
        });
      }
      return fakeBackground(message);
    };
    await boot();

    const button = () => document.querySelector<HTMLButtonElement>('#rejected-clear')!;
    expect(button().disabled).toBe(false);
    const label = button().textContent;
    button().click();
    // Synchronously, not when the reply lands — that is the whole window.
    expect(button().disabled).toBe(true);
    // And says something, because disabling removes the second click but not
    // the silence that invites it.
    expect(button().textContent).not.toBe(label);

    answer?.();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
    expect(sentMessages.filter((m) => m.type === 'CLEAR_REJECTED')).toHaveLength(1);
    expect(button().textContent).toBe(label);
  });

  it('corrects a late clear when the popup is next opened', async () => {
    // What actually recovers a clear that landed after being reported failed.
    // A 31s `setTimeout` used to claim that job and could not do it: a
    // browser-action popup is destroyed the moment it loses focus, taking its
    // timers with it, so in ordinary use it never fired. `main()` re-reading
    // storage is the mechanism, and `clearAttempt` living only in memory is
    // what stops the message outliving the list it was about.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    // A worker that answers without having cleared yet.
    sendMessageImpl = (message) =>
      message.type === 'CLEAR_REJECTED'
        ? Promise.resolve({ type: 'RUN_STATE', state: null })
        : fakeBackground(message);
    await boot();
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);
    });

    // The clear lands after the fact, and the popup is reopened.
    savedRejected = [];
    vi.resetModules();
    document.body.innerHTML = BODY;
    installChrome();
    sendMessageImpl = fakeBackground;
    await boot();

    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#rejected-note')?.textContent).not.toMatch(
      /not been cleared yet/,
    );
  });

  it('says the clear did not happen when rendering the reply throws', async () => {
    // The chain had no `.catch`, so a throw skipped the renders and left the
    // popup on its pre-clear counts — reported as an unhandled rejection with
    // no message. `applyReply` is the reachable thrower: the state it renders
    // comes from `chrome.storage.session`, which an older build may have
    // written, and `renderRun` walks it unguarded.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = (message) => {
      if (message.type === 'CLEAR_REJECTED') {
        // A state shaped like something an older build wrote.
        return Promise.resolve({ type: 'RUN_STATE', state: { plan: null, quotes: null } });
      }
      return fakeBackground(message);
    };
    await boot();

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);
    });
    // And the button comes back, or the user cannot take the advice.
    expect(document.querySelector<HTMLButtonElement>('#rejected-clear')?.disabled).toBe(false);
  });

  it('does not let stranded rows crowd out every company that can race', async () => {
    // Stranded rows go first so the 60-row cut cannot swallow the escape hatch;
    // uncapped, the escape hatch swallowed the list instead. `stranded` is
    // bounded only by how many companies the user has ticked.
    const { allCompanies } = await import('../src/core/codes.js');
    const has = (company: { codes: Array<{ code: string | null; vendor: string }> }, v: string) =>
      company.codes.some((code) => code.code && code.vendor === v);
    const marriottOnly = allCompanies()
      .filter((company) => has(company, 'marriott') && !has(company, 'hilton'))
      .slice(0, 30);
    expect(marriottOnly.length).toBeGreaterThan(20);
    savedForm = {
      category: 'hotel',
      vendors: ['hilton'],
      companies: marriottOnly.map((company) => company.slug),
    };
    installChrome();
    await boot();

    const rows = () => [...document.querySelectorAll('#company-list label.company')];
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const strandedShown = rows().filter(
      (row) => row.querySelector('.vendors')?.textContent === 'no code at these vendors',
    ).length;
    // Enough to untick from, and not the whole page.
    expect(strandedShown).toBeLessThanOrEqual(10);
    expect(rows().length - strandedShown).toBeGreaterThan(40);
  });

  it('does not call a re-refused code a failed clear', async () => {
    // Re-asking the vendor is the whole point of the button, and the vendor
    // refusing the same code again is the expected outcome. `clearAttempt` was
    // never retired, so the next finished run saw that key back in the list and
    // printed "those codes have not been cleared yet" — about a clear that
    // demonstrably worked and a refusal that postdates it.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });

    // A later run asks again and gets the same answer — the same code.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (i: unknown) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      rejectedCodes: [{ vendor: 'national', code: '5666666', at: 2 }],
    });
    await broadcastFinishedRun();

    const note = document.querySelector('#rejected-note')?.textContent ?? '';
    expect(note).toMatch(/1 code has been refused/);
    expect(note).not.toMatch(/not been cleared yet/);
  });

  it('does not re-arm Run from a clear while a START_RUN is outstanding', async () => {
    // A clear's reply is not an answer to START_RUN, and `renderRun` clears
    // `pendingStart` unconditionally. `beginRun` awaits `cancelRun` before
    // assigning `active`, so a clear answered inside that gap reports the
    // previous finished run — or none — and Run comes back to life with a race
    // about to start behind it. A second press then sends the second START_RUN
    // the latch exists to stop.
    //
    // The failed-send case is the same call and the same answer: a rejection
    // does not prove non-delivery, so the message and the dead button are
    // supposed to stay until the popup is reopened. An earlier version of this
    // test asserted the opposite — that a clear should re-arm Run — which read
    // as a fix for a stale plan line and was really a hole in the double-run
    // guard.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();

    sendMessageImpl = () => Promise.reject(new Error('worker is gone'));
    fillCarForm();
    document.querySelector<HTMLButtonElement>('#run-btn')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#run-btn')?.textContent).toMatch(/Reopen the popup/);
    });

    // The worker answers the clear. The refusal list may update; the run state
    // must not.
    sendMessageImpl = fakeBackground;
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });

    expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(true);
    expect(document.querySelector('#run-btn')?.textContent).toMatch(/Reopen the popup/);
    expect(document.querySelector('#plan-summary')?.textContent).toMatch(/Could not reach/);
  });

  it('fixes the Run caption when a clear proves the background is reachable', async () => {
    // `runBtn.textContent` is written in exactly two places, and this path calls
    // neither — so clearing `ui.sendFailed` re-enabled the button while it still
    // read "Reopen the popup to retry", which actually starts a race.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    sendMessageImpl = () => Promise.reject(new Error('worker is asleep'));
    await boot();
    await vi.waitFor(() => {
      expect(document.querySelector('#run-btn')?.textContent).toMatch(/Reopen the popup/);
    });

    sendMessageImpl = fakeBackground;
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#run-btn')?.disabled).toBe(false);
    });
    expect(document.querySelector('#run-btn')?.textContent).toBe('Find the cheapest code');
  });

  it('retires a failed-clear message when the list is read again', async () => {
    // The flag had no reset but a *successful* clear, and "none needed" held
    // only while nothing could refill the list. The worker's bounded wait can
    // give up on a slow write — setting the flag — and the queued clear then
    // lands anyway; a later run refusing some entirely different code redrew
    // the note saying those codes "have not been cleared yet", about a store
    // that had been cleared and a refusal that postdates it.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    // A clear that reports failure: the reply comes back, storage unchanged.
    sendMessageImpl = () => Promise.resolve({ type: 'RUN_STATE', state: null });
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.textContent).toMatch(/not been cleared yet/);
    });

    // Now a later run records a different refusal, and the listener re-reads.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (i: unknown) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      rejectedCodes: [{ vendor: 'national', code: 'XZ15J55', at: 2 }],
    });
    await broadcastFinishedRun();

    const note = document.querySelector('#rejected-note')?.textContent ?? '';
    expect(note).toMatch(/1 code has been refused/);
    expect(note).not.toMatch(/not been cleared yet/);
  });

  it('counts the refused note the way everything else counts it', async () => {
    // `loadRejected` accepts whatever an older build wrote and does not dedupe,
    // which is the stated premise for the two-directional `changed` check in the
    // RUN_STATE listener. Under that premise this line said "2 codes have been
    // refused" while the chips, the company list and the plan all accounted for
    // one.
    savedRejected = [
      { vendor: 'national', code: '5666666', at: 1 },
      { vendor: 'national', code: '5666666', at: 1 },
    ];
    installChrome();
    await boot();

    expect(document.querySelector('#rejected-count')?.textContent).toMatch(/^1 code has/);
  });

  it('does not complain when the clear worked but the reply did not arrive', async () => {
    // The mirror of the test above, and the reason both judge storage rather
    // than the reply. `send` retries and a rejection does not prove
    // non-delivery — this file already reasons that way about START_RUN — so a
    // clear that really happened while the response channel dropped must not be
    // reported as a failure. Treating it as one left `ui.rejected` populated for
    // the rest of the session, filtering out codes the store no longer refused.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    sendMessageImpl = (message) => {
      // Delivered and acted on; only the answer is lost.
      void fakeBackground(message);
      return Promise.reject(new Error('response channel closed'));
    };

    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    });
    expect(document.querySelector('#plan-summary')?.textContent).not.toMatch(
      /not been cleared yet/,
    );
  });

  it('does not let a finishing run undo a clear the user just made', async () => {
    // Three places read the refusal list — boot, the finished-run broadcast and
    // the clear — and none was ordered against the others, so whichever
    // `storage.get` resolved last won regardless of which was *issued* last.
    // A run finishing as the user presses "try them again" therefore left the
    // popup holding the pre-clear list: the codes they had just cleared went on
    // being skipped and the note came back seconds later, with nothing to
    // correct it until the popup was reopened.
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    installChrome();
    await boot();
    await vi.waitFor(() => {
      expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(false);
    });

    // The broadcast's read is issued first and resolves last — the interleaving
    // that used to win. One slow read is enough: the clear's own read is fast.
    getDelayMs = 200;
    slowReadsLeft = 1;
    for (const listener of broadcastListeners) {
      listener({ type: 'RUN_STATE', state: { plan: PLAN, quotes: [], finishedAt: 1 } });
    }
    document.querySelector<HTMLButtonElement>('#rejected-clear')?.click();

    await new Promise((resolve) => setTimeout(resolve, 400));
    // The stale read must not have put the cleared codes back.
    expect(document.querySelector('#rejected-note')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#plan-summary')?.textContent ?? '').not.toMatch(/refused/);
  });

  it('reloads refused codes when a run finishes, so the next Run skips them', async () => {
    // The popup usually stays open across a run. Loaded once at boot,
    // `ui.rejected` would still be empty afterwards and pressing Run again
    // would re-race codes the vendor refused a moment ago — a real tab spent
    // rediscovering a refusal, which is the one thing this feature avoids.
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
    await boot();

    // Nothing selected in storage means the popup fills it in, so untick by
    // hand — the state only a user can reach. Nothing else is dispatched: this
    // used to poke `#company-search` to force a re-render, which meant the test
    // passed against a popup that never redrew the list when the selection
    // changed. The chip's own handler has to do it.
    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      if (box.checked) box.click();
    }

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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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

  it('redraws the company list when a vendor chip is toggled', async () => {
    // The list is a function of the vendor selection — which companies match,
    // which vendors each row is labelled with, and which empty-state message
    // applies — and the chip handler never redrew it. Unticking Avis and Hertz
    // to leave only National is this PR's own motivating scenario, and it left
    // every Avis and Hertz row on screen with its old labels.
    sendMessageImpl = fakeBackground;
    await boot();

    const labels = () =>
      [...document.querySelectorAll('#company-list .vendors')]
        .map((el) => el.textContent ?? '')
        .join(' ');
    expect(labels()).toMatch(/Hertz/);

    for (const box of document.querySelectorAll<HTMLInputElement>('#vendor-chips input')) {
      const chip = box.closest('label')?.textContent ?? '';
      if (!chip.includes('National') && box.checked) box.click();
    }

    expect(labels()).not.toMatch(/Hertz/);
    expect(labels()).toMatch(/National/);
  });

  it('notices a same-sized change to the refused set', async () => {
    // `loadRejected` deliberately tolerates whatever an older build wrote and
    // does not dedupe, so counting entries is not the same as comparing sets: a
    // stored `[A, A]` against a held `[A, B]` matches on length and on every
    // stored key being one we already had. B's codes would stay excluded from
    // the chip counts and the company list until the popup was reopened.
    savedRejected = [
      { vendor: 'national', code: '5666666', at: 1 },
      { vendor: 'national', code: 'XZ15J55', at: 1 },
    ];
    installChrome();
    sendMessageImpl = fakeBackground;
    await boot();

    const count = () =>
      [...document.querySelectorAll('#vendor-chips .chip')]
        .find((el) => (el.textContent ?? '').includes('National'))
        ?.querySelector('.count')?.textContent;
    expect(count()).toBe('17');

    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (i: unknown) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      rejectedCodes: [
        { vendor: 'national', code: '5666666', at: 1 },
        { vendor: 'national', code: '5666666', at: 1 },
      ],
    });
    await broadcastFinishedRun();

    await vi.waitFor(() => expect(count()).toBe('18'));
  });

  it('draws nothing when a run finishes before boot has a selection', async () => {
    // The RUN_STATE listener is registered at module scope, so a broadcast can
    // land while `main()` is still awaiting storage. Moving the default-fill out
    // of the render made that reachable: the handler would draw every chip
    // unticked and print "Pick at least one vendor" under a user who has several
    // picked, until `setCategory` corrected it a moment later.
    savedForm = { category: 'car', vendors: ['national'], companies: [] };
    savedRejected = [{ vendor: 'national', code: '5666666', at: 1 }];
    // Only boot's *first* read is slowed, and generously. Slowing two of them
    // does not work and the reason is the whole shape of this test: the reads
    // interleave by time rather than by count, so the broadcast's own read takes
    // the second slow slot and the handler renders *after* boot — which is
    // exactly the state this is trying to catch the popup not being in, so the
    // mutant passes. One slow read leaves the handler's read fast, so it renders
    // within milliseconds while boot is still 600ms away.
    getDelayMs = 600;
    slowReadsLeft = 1;
    installChrome();
    sendMessageImpl = fakeBackground;

    const started = import('../src/popup/popup.js');
    await vi.waitFor(() => expect(broadcastListeners.length).toBeGreaterThan(0));
    await broadcastFinishedRun();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mid-boot: nothing drawn is the correct amount to draw. Either state below
    // would be a lie about a selection that has been restored but not applied.
    // `renderRun` ran, so the listener really did reach the branch under test
    // rather than throwing on the way — which would pass these two for free.
    expect(document.querySelector('#results')?.hasAttribute('hidden')).toBe(false);
    const chips = () => [...document.querySelectorAll<HTMLInputElement>('#vendor-chips input')];
    expect(chips().some((box) => !box.checked)).toBe(false);
    expect(document.querySelector('#company-list')?.textContent ?? '').not.toMatch(
      /Pick at least one vendor/,
    );

    // And boot still lands, with the saved selection — so this test is watching
    // a popup that works, not one wedged behind a slow read.
    await started;
    await vi.waitFor(() => expect(chips().length).toBeGreaterThan(0));
    expect(chips().filter((box) => box.checked)).toHaveLength(1);
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
    sendMessageImpl = fakeBackground;
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
