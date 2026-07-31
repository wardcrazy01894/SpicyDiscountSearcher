import { buildDeepLink } from '../core/deeplinks.js';
import { bestOffer } from '../core/extract.js';
import type { BackgroundRequest, ProbeAssignment, StateMessage } from '../core/messages.js';
import type {
  Candidate,
  ProbeReport,
  Quote,
  QuoteFailure,
  RunState,
  SearchPlan,
} from '../core/types.js';

/**
 * Runs a price race.
 *
 * Each candidate code gets its own tab in a dedicated minimised window so the
 * user's browsing isn't hijacked by a dozen rental sites. Tabs open a few at a
 * time, the content script reports back whatever prices it finds, and the tab
 * closes immediately after — win, lose, or time out.
 */

const STATE_KEY = 'runState';
/** Window id of a run in flight, so a restarted worker can close the orphan. */
const WINDOW_KEY = 'runWindow';
const PROBE_TIMEOUT_MS = 45_000;
/** Time the background keeps in hand after the probe's own deadline passes. */
const PROBE_GRACE_MS = 5_000;
/** Breathing room between tab loads so we don't hammer a vendor. */
const STAGGER_MS = 750;

interface ActiveRun {
  state: RunState;
  /** Tab id -> quote id, so a probing content script can identify itself. */
  tabs: Map<number, string>;
  /** Quote id -> absolute ms deadline, so a redirect can't reset the clock. */
  deadlines: Map<string, number>;
  windowId: number | null;
  /** In-flight window creation, so concurrent lanes share one window. */
  windowPromise: Promise<number> | null;
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

/**
 * Persist and broadcast the current state. Deliberately cannot throw.
 *
 * This is awaited from inside runQuote and its `finally`. An escaping rejection
 * — storage quota, storage unavailable during shutdown — used to reject the
 * Promise.all in startRun and skip the completion block entirely, leaving
 * finishedAt unset, the minimised window open, and the popup stuck on "Racing
 * codes…" forever.
 */
async function publish(): Promise<void> {
  if (!active) return;
  try {
    await persist(active.state);
  } catch {
    // Storage is best-effort here; losing the snapshot costs a resumed popup,
    // while throwing costs the whole run.
  }
  broadcast(active.state);
}

/**
 * Finish off a run that no service worker is behind any more.
 *
 * MV3 can suspend the worker mid-race — there can be 40s of message silence
 * while a vendor page loads. The persisted snapshot then still says quotes are
 * loading, so the popup computes `running = true`, disables the Run button on
 * every open for the rest of the browser session, and Cancel cannot clear it
 * because cancelRun() returns immediately when there is no active run.
 */
function reapInterrupted(state: RunState | null): RunState | null {
  if (!state || state.finishedAt) return state;
  const now = Date.now();
  for (const quote of state.quotes) {
    if (quote.finishedAt) continue;
    quote.status = 'error';
    quote.failure = 'interrupted';
    quote.message = 'the extension was suspended mid-run';
    quote.finishedAt = now;
  }
  state.finishedAt = now;
  return state;
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

/**
 * The only failures a content script is allowed to claim.
 *
 * It runs in a page we do not control, so anything else it sends is not a
 * diagnosis — including plausible-looking codes like `cancelled` or
 * `tab-closed`, which would misattribute the failure to the user.
 */
const PROBE_FAILURES = new Set<QuoteFailure>(['extract-threw', 'probe-empty']);

/**
 * Did the deep link land somewhere other than the search we asked for?
 *
 * README is explicit that these URLs are reverse-engineered and expected to
 * rot, and the failure is silent: a vendor home page still shows "from $19/day",
 * so the quote comes back `ok` and simply wins. The site root is the one
 * unambiguous tell — it is never a results page — so that is all this claims.
 *
 * Blind for avis and budget by construction: their builders already target
 * /en/home, so a link that fails to apply the code lands exactly where it was
 * asked to. Detecting those needs a per-vendor "this is what a results page
 * looks like" signal, which is a different change.
 */
function landedElsewhere(quote: Quote | undefined, report: ProbeReport | undefined): boolean {
  // A content script runs in a page we do not control, so treat its message as
  // input rather than as a promise kept.
  if (!quote?.url || !report) return false;
  let asked: string;
  try {
    asked = new URL(quote.url).pathname;
  } catch {
    return false;
  }
  const landed = report.finalPath;
  return (landed === '/' || landed === '') && asked !== '/' && asked !== '';
}

function makeQuote(candidate: Candidate, plan: SearchPlan): Quote {
  const id = `${candidate.vendor}:${candidate.code}`;
  try {
    const link = buildDeepLink(candidate.vendor, candidate.code, plan.trip);
    return {
      id,
      candidate,
      url: link.url,
      confidence: link.confidence,
      status: 'pending',
      offers: [],
      best: null,
    };
  } catch (error) {
    return {
      id,
      candidate,
      url: '',
      confidence: 'best-effort',
      status: 'error',
      offers: [],
      best: null,
      failure: 'link-build',
      message: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    };
  }
}

async function ensureWindow(run: ActiveRun): Promise<number> {
  if (run.windowId !== null) return run.windowId;

  // Memoised rather than check-then-create. Every lane awaits publish() before
  // reaching here, so with the default concurrency of 2 both lanes saw
  // windowId === null and both created a window — and only the last id
  // assigned was ever closed, leaking an invisible minimised window on every
  // run. It does not self-close either: created with no url, it holds a
  // new-tab page that outlives the probe tabs.
  const pending = (run.windowPromise ??= (async () => {
    // Minimised keeps a dozen rental-car pages out of the user's face while
    // they load. Brave and Chrome both still render and run scripts in it.
    const created = await chrome.windows.create({ state: 'minimized', focused: false });
    // windows.create can resolve undefined — @types/chrome 0.2 says so and the
    // older typings did not, so this was a live "cannot read id of undefined"
    // waiting for the one call that failed.
    if (created?.id === undefined) throw new Error('could not open a background window');
    run.windowId = created.id;
    // Recorded so a restarted worker can close what this one orphaned.
    await chrome.storage.session.set({ [WINDOW_KEY]: created.id }).catch(() => {});
    return created.id;
  })());

  try {
    return await pending;
  } catch (error) {
    // Only clear our own attempt: a later lane may already have replaced it,
    // and nulling that one would let yet another lane open a second window.
    if (run.windowPromise === pending) run.windowPromise = null;
    throw error;
  }
}

/** Close the run's window, if it still has one, and forget it. */
async function closeWindow(run: ActiveRun): Promise<void> {
  run.windowPromise = null;
  await chrome.storage.session.remove(WINDOW_KEY).catch(() => {});
  if (run.windowId === null) return;
  try {
    await chrome.windows.remove(run.windowId);
  } catch {
    // Already closed, possibly by the user.
  }
  run.windowId = null;
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
    // Cancel can land while the window is still opening. Without this the run
    // goes on to load vendor pages *after* the user pressed Cancel, which is
    // exactly the hijacking the minimised window exists to avoid.
    if (run.cancelled || quote.finishedAt) return;
    const tab = await chrome.tabs.create({ url: quote.url, windowId, active: false });
    tabId = tab.id;
    if (tabId === undefined) throw new Error('tab did not open');
    run.tabs.set(tabId, quote.id);
    // Absolute, so a vendor that bounces through a consent interstitial and
    // re-injects the probe cannot hand it a fresh budget the background will
    // not honour — the tab used to be killed 5s into a "40s" probe deadline.
    run.deadlines.set(quote.id, Date.now() + PROBE_TIMEOUT_MS - PROBE_GRACE_MS);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        finishQuote(run, quote.id, {
          status: 'no-price',
          failure: 'probe-timeout',
          message: 'the tab never reported back before the deadline',
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
      failure: 'tab-open',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    run.deadlines.delete(quote.id);
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

/**
 * Set for the window between entering startRun and `active` being assigned.
 *
 * `cancelRun()` returns immediately when `active` is null, so two START_RUN
 * messages arriving before either finished both sailed past it and both built
 * a run. The result was two live races: two minimised windows, twice the
 * concurrency cap, twice the load on every vendor — a direct breach of the
 * politeness contract — and the first run's window orphaned permanently,
 * because `runWindow` had already been overwritten by the second.
 *
 * A double-click on Run was enough to do it.
 */
let startingRun: Promise<RunState> | null = null;

async function startRun(plan: SearchPlan): Promise<RunState> {
  // Read and assigned with no await in between, which is the whole point: an
  // async guard is not a guard, and that is exactly how `cancelRun()` failed
  // at this job.
  //
  // Sharing the in-flight promise rather than refusing outright, because the
  // second caller then gets the run that really is starting. Refusing meant
  // answering it from `active`, which on the very first burst is still null —
  // so the popup received `state: null`, read it as "no run", and re-armed the
  // button. The strengthened test caught that; a `type === 'RUN_STATE'`
  // assertion had not.
  if (startingRun) return startingRun;
  const pending = (startingRun = beginRun(plan));
  try {
    return await pending;
  } finally {
    if (startingRun === pending) startingRun = null;
  }
}

async function beginRun(plan: SearchPlan): Promise<RunState> {
  await cancelRun();

  const quotes = plan.candidates.map((candidate) => makeQuote(candidate, plan));
  const state: RunState = { plan, quotes };
  const run: ActiveRun = {
    state,
    tabs: new Map(),
    deadlines: new Map(),
    windowId: null,
    windowPromise: null,
    cancelled: false,
    waiters: new Map(),
  };
  active = run;
  await publish();

  const queue = quotes.filter((q) => !q.finishedAt);
  const lanes = Math.max(1, Math.min(plan.concurrency, 6));

  void (async () => {
    try {
      await Promise.all(Array.from({ length: lanes }, () => worker(run, queue)));
    } finally {
      // In a finally so that a lane throwing cannot skip teardown and strand
      // the run with its window open and the popup showing "Racing codes…".
      if (active === run) {
        run.state.finishedAt = Date.now();
        await closeWindow(run);
        await publish();
      }
    }
  })();

  return state;
}

async function cancelRun(): Promise<void> {
  const run = active;
  if (!run) return;
  run.cancelled = true;

  for (const quote of [...run.state.quotes]) {
    finishQuote(run, quote.id, { status: 'cancelled', failure: 'cancelled' });
  }
  // finishQuote returns early for a quote already marked finished, so a lane
  // waiting on a duplicate quote id keeps waiting. Not forever — the probe
  // timeout resolves it after 45s, and the window is closed below regardless —
  // so this buys a prompt teardown rather than a delayed one. buildCandidates
  // dedupes on `${vendor}:${code}`, so the popup cannot produce a duplicate id
  // today; this is the cheap guard for a plan that arrives another way.
  for (const resolve of run.waiters.values()) resolve();
  run.waiters.clear();
  for (const tabId of run.tabs.keys()) await closeTab(tabId);
  run.tabs.clear();
  run.deadlines.clear();

  await closeWindow(run);

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
          // No refusal path any more: a concurrent START_RUN shares the run
          // that is already starting, so both callers get the same state and
          // one Run press produces one race.
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
          if (active) {
            sendResponse({ type: 'RUN_STATE', state: active.state } satisfies StateMessage);
            return;
          }
          // No active run, so anything unfinished in the snapshot belongs to a
          // worker that was suspended. Settle it before the popup sees it.
          const state = reapInterrupted(await loadPersisted());
          if (state) await persist(state).catch(() => {});
          sendResponse({ type: 'RUN_STATE', state } satisfies StateMessage);
          return;
        }
        case 'PROBE_READY': {
          const tabId = sender.tab?.id;
          const quoteId = tabId === undefined ? undefined : active?.tabs.get(tabId);
          const quote = active && quoteId !== undefined ? quoteFor(active, quoteId) : undefined;
          // A mapped tab whose quote has vanished is an impossible state.
          // Defaulting the vendor turned it into a silent wrong-vendor scrape:
          // a Marriott page read with Hertz selectors, reported as a result.
          if (!active || quoteId === undefined || !quote) {
            sendResponse({ type: 'PROBE_IDLE' } satisfies ProbeAssignment);
            return;
          }
          // Past its deadline, this tab is about to be closed. Handing the
          // probe a token second of work would have it scrape a page nobody is
          // waiting on — the content script is supposed to stay inert unless
          // the background genuinely wants an answer from it.
          //
          // This is a behaviour change, not a no-op: a probe injected in the
          // last five seconds used to get one poll in and could report. A page
          // that only reached document_idle at t+40s almost never has prices
          // 1.5s later, so the trade is worth it — but it is a trade.
          const remaining = (active.deadlines.get(quoteId) ?? 0) - Date.now();
          if (remaining <= 0) {
            sendResponse({ type: 'PROBE_IDLE' } satisfies ProbeAssignment);
            return;
          }
          sendResponse({
            type: 'PROBE_START',
            vendor: quote.candidate.vendor,
            quoteId,
            timeoutMs: remaining,
          } satisfies ProbeAssignment);
          return;
        }
        case 'PROBE_RESULT': {
          const tabId = sender.tab?.id;
          const quoteId = tabId === undefined ? undefined : active?.tabs.get(tabId);
          if (active && quoteId !== undefined) {
            const best = bestOffer(message.offers);
            const quote = quoteFor(active, quoteId);
            finishQuote(active, quoteId, {
              status: best ? 'ok' : 'no-price',
              offers: message.offers,
              best,
              report: message.report,
              ...(landedElsewhere(quote, message.report) ? { suspect: 'landed-elsewhere' } : {}),
              // bestOffer only returns null for an empty list, and the probe
              // never sends one — it reports PROBE_FAILED instead. Kept as a
              // real guard rather than a message describing a state it cannot
              // be in: if that ever changes, this says so honestly.
              ...(best ? {} : { failure: 'probe-empty', message: 'the page reported no offers' }),
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
            const failed = quoteFor(active, quoteId);
            finishQuote(active, quoteId, {
              status: 'no-price',
              // Unrecognised means unrecognised. Coercing it to probe-empty
              // would render "page loaded, no price appeared" — a specific
              // claim with nothing behind it, which is the thing this whole
              // change exists to stop. Leaving it unset falls back to the
              // message the script did send.
              ...(PROBE_FAILURES.has(message.failure) ? { failure: message.failure } : {}),
              message: message.message,
              report: message.report,
              // "no price because the link missed its search" and "no price
              // because the results page was empty" is exactly the distinction
              // this is for, and the evidence is already in hand.
              ...(landedElsewhere(failed, message.report) ? { suspect: 'landed-elsewhere' } : {}),
            });
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

/**
 * Close a window left behind by a suspended worker.
 *
 * Nothing else ever will: the window is minimised and holds a new-tab page, so
 * it outlives its probe tabs and the user cannot see it to close it.
 */
async function reapOrphanWindow(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    const windowId = stored[WINDOW_KEY] as number | undefined;
    // A run that started while this lookup was in flight owns its own window.
    // Never close a live one.
    if (windowId === undefined || active !== null) return;
    await chrome.storage.session.remove(WINDOW_KEY);
    await chrome.windows.remove(windowId);
  } catch {
    // No orphan, or it is already gone.
  }
}

// Runs whenever the worker wakes, which is the only moment we know a previous
// one is no longer around to clean up after itself.
void reapOrphanWindow();

// A tab the user closes mid-probe should release its lane instead of blocking
// the queue until the timeout fires.
chrome.tabs.onRemoved.addListener((tabId) => {
  const run = active;
  const quoteId = run?.tabs.get(tabId);
  if (!run || quoteId === undefined) return;
  run.tabs.delete(tabId);
  finishQuote(run, quoteId, {
    status: 'no-price',
    failure: 'tab-closed',
    message: 'the tab was closed before it reported a price',
  });
  void publish();
});
