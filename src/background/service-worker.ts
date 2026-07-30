import { buildDeepLink } from '../core/deeplinks.js';
import { bestOffer } from '../core/extract.js';
import type { BackgroundRequest, ProbeAssignment, StateMessage } from '../core/messages.js';
import type { Candidate, Quote, RunState, SearchPlan } from '../core/types.js';

/**
 * Runs a price race.
 *
 * Each candidate code gets its own tab in a dedicated minimised window so the
 * user's browsing isn't hijacked by a dozen rental sites. Tabs open a few at a
 * time, the content script reports back whatever prices it finds, and the tab
 * closes immediately after — win, lose, or time out.
 */

const STATE_KEY = 'runState';
const PROBE_TIMEOUT_MS = 45_000;
/** Breathing room between tab loads so we don't hammer a vendor. */
const STAGGER_MS = 750;

interface ActiveRun {
  state: RunState;
  /** Tab id -> quote id, so a probing content script can identify itself. */
  tabs: Map<number, string>;
  windowId: number | null;
  cancelled: boolean;
  /** Resolvers waiting on a quote to finish, keyed by quote id. */
  waiters: Map<string, () => void>;
}

let active: ActiveRun | null = null;

async function persist(state: RunState | null): Promise<void> {
  if (state) await chrome.storage.session.set({ [STATE_KEY]: state });
  else await chrome.storage.session.remove(STATE_KEY);
}

async function loadPersisted(): Promise<RunState | null> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return (stored[STATE_KEY] as RunState | undefined) ?? null;
}

function broadcast(state: RunState | null): void {
  const message: StateMessage = { type: 'RUN_STATE', state };
  // The popup is often closed; a missing receiver is expected, not an error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function publish(): Promise<void> {
  if (!active) return;
  await persist(active.state);
  broadcast(active.state);
}

function quoteFor(run: ActiveRun, quoteId: string): Quote | undefined {
  return run.state.quotes.find((q) => q.id === quoteId);
}

function finishQuote(run: ActiveRun, quoteId: string, patch: Partial<Quote>): void {
  const quote = quoteFor(run, quoteId);
  if (!quote || quote.finishedAt) return;
  Object.assign(quote, patch, { finishedAt: Date.now() });
  run.waiters.get(quoteId)?.();
  run.waiters.delete(quoteId);
}

function makeQuote(candidate: Candidate, plan: SearchPlan): Quote {
  const id = `${candidate.vendor}:${candidate.code}`;
  try {
    const link = buildDeepLink(candidate.vendor, candidate.code, plan.trip);
    return { id, candidate, url: link.url, status: 'pending', offers: [], best: null };
  } catch (error) {
    return {
      id,
      candidate,
      url: '',
      status: 'error',
      offers: [],
      best: null,
      message: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    };
  }
}

async function ensureWindow(run: ActiveRun): Promise<number> {
  if (run.windowId !== null) return run.windowId;
  // Minimised keeps a dozen rental-car pages out of the user's face while they
  // load. Brave and Chrome both still render and run scripts in it.
  const created = await chrome.windows.create({ state: 'minimized', focused: false });
  run.windowId = created.id ?? null;
  if (run.windowId === null) throw new Error('could not open a background window');
  return run.windowId;
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Already gone — the user may have closed the window themselves.
  }
}

async function runQuote(run: ActiveRun, quote: Quote): Promise<void> {
  if (run.cancelled || quote.finishedAt) return;

  quote.status = 'loading';
  quote.startedAt = Date.now();
  await publish();

  let tabId: number | undefined;
  try {
    const windowId = await ensureWindow(run);
    const tab = await chrome.tabs.create({ url: quote.url, windowId, active: false });
    tabId = tab.id;
    if (tabId === undefined) throw new Error('tab did not open');
    run.tabs.set(tabId, quote.id);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        finishQuote(run, quote.id, {
          status: 'no-price',
          message: 'timed out before any price appeared',
        });
        resolve();
      }, PROBE_TIMEOUT_MS);

      run.waiters.set(quote.id, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    finishQuote(run, quote.id, {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (tabId !== undefined) {
      run.tabs.delete(tabId);
      await closeTab(tabId);
    }
    await publish();
  }
}

async function worker(run: ActiveRun, queue: Quote[]): Promise<void> {
  for (;;) {
    if (run.cancelled) return;
    const next = queue.shift();
    if (!next) return;
    await runQuote(run, next);
    await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
  }
}

async function startRun(plan: SearchPlan): Promise<RunState> {
  await cancelRun();

  const quotes = plan.candidates.map((candidate) => makeQuote(candidate, plan));
  const state: RunState = {
    runId: `run-${Date.now()}`,
    plan,
    quotes,
    startedAt: Date.now(),
  };
  const run: ActiveRun = {
    state,
    tabs: new Map(),
    windowId: null,
    cancelled: false,
    waiters: new Map(),
  };
  active = run;
  await publish();

  const queue = quotes.filter((q) => !q.finishedAt);
  const lanes = Math.max(1, Math.min(plan.concurrency, 6));

  void (async () => {
    await Promise.all(Array.from({ length: lanes }, () => worker(run, queue)));
    if (active === run) {
      run.state.finishedAt = Date.now();
      if (run.windowId !== null) {
        try {
          await chrome.windows.remove(run.windowId);
        } catch {
          // The window may already be closed.
        }
        run.windowId = null;
      }
      await publish();
    }
  })();

  return state;
}

async function cancelRun(): Promise<void> {
  const run = active;
  if (!run) return;
  run.cancelled = true;

  for (const quoteId of run.waiters.keys()) {
    finishQuote(run, quoteId, { status: 'cancelled' });
  }
  for (const quote of run.state.quotes) {
    if (!quote.finishedAt) {
      quote.status = 'cancelled';
      quote.finishedAt = Date.now();
    }
  }
  for (const tabId of run.tabs.keys()) await closeTab(tabId);
  run.tabs.clear();

  if (run.windowId !== null) {
    try {
      await chrome.windows.remove(run.windowId);
    } catch {
      // Already closed.
    }
    run.windowId = null;
  }

  run.state.finishedAt ??= Date.now();
  await publish();
}

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    void (async () => {
      switch (message.type) {
        case 'START_RUN': {
          const state = await startRun(message.plan);
          sendResponse({ type: 'RUN_STATE', state } satisfies StateMessage);
          return;
        }
        case 'CANCEL_RUN': {
          await cancelRun();
          sendResponse({
            type: 'RUN_STATE',
            state: active?.state ?? null,
          } satisfies StateMessage);
          return;
        }
        case 'GET_STATE': {
          const state = active?.state ?? (await loadPersisted());
          sendResponse({ type: 'RUN_STATE', state } satisfies StateMessage);
          return;
        }
        case 'PROBE_READY': {
          const tabId = sender.tab?.id;
          const quoteId = tabId === undefined ? undefined : active?.tabs.get(tabId);
          if (!active || quoteId === undefined) {
            sendResponse({ type: 'PROBE_IDLE' } satisfies ProbeAssignment);
            return;
          }
          const quote = quoteFor(active, quoteId);
          sendResponse({
            type: 'PROBE_START',
            vendor: quote?.candidate.vendor ?? 'hertz',
            quoteId,
            timeoutMs: PROBE_TIMEOUT_MS - 5_000,
          } satisfies ProbeAssignment);
          return;
        }
        case 'PROBE_RESULT': {
          const tabId = sender.tab?.id;
          const quoteId = tabId === undefined ? undefined : active?.tabs.get(tabId);
          if (active && quoteId !== undefined) {
            const best = bestOffer(message.offers);
            finishQuote(active, quoteId, {
              status: best ? 'ok' : 'no-price',
              offers: message.offers,
              best,
              ...(best ? {} : { message: 'page loaded but showed no usable price' }),
            });
            await publish();
          }
          sendResponse({ ok: true });
          return;
        }
        case 'PROBE_FAILED': {
          const tabId = sender.tab?.id;
          const quoteId = tabId === undefined ? undefined : active?.tabs.get(tabId);
          if (active && quoteId !== undefined) {
            finishQuote(active, quoteId, { status: 'no-price', message: message.message });
            await publish();
          }
          sendResponse({ ok: true });
          return;
        }
        default: {
          sendResponse({ ok: false });
        }
      }
    })();
    return true; // keep the channel open for the async work above
  },
);

// A tab the user closes mid-probe should release its lane instead of blocking
// the queue until the timeout fires.
chrome.tabs.onRemoved.addListener((tabId) => {
  const run = active;
  const quoteId = run?.tabs.get(tabId);
  if (!run || quoteId === undefined) return;
  run.tabs.delete(tabId);
  finishQuote(run, quoteId, { status: 'no-price', message: 'tab closed before pricing' });
  void publish();
});
