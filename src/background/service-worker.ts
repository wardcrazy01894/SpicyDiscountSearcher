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
  /**
   * Tab id -> quote id for tabs already retired, kept only so a reply that
   * arrives after the deadline can still be attributed.
   *
   * Deliberately separate from `tabs` rather than a delayed delete: a tab in
   * here can no longer be assigned work, settle a quote, or change a verdict.
   * It can attach evidence and nothing else. Merging the two would let a page
   * that missed its deadline win a race the user already saw finish.
   */
  retiredTabs: Map<number, string>;
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
 * The one place this extension writes a log line.
 *
 * There is no log store to ship to and the service-worker console dies with
 * the worker, so `Quote.failure` and `Quote.report` remain the real telemetry —
 * this is the backstop for the failures that belong to no quote. Every call
 * site below was previously a bare `catch {}` whose comment named the benign
 * cause and could not tell it from a real one.
 *
 * Never pass a URL or a code: the query string carries the discount code and
 * the user's itinerary, and this is the one channel with no reviewer.
 */
function warn(what: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[spicy] ${what}: ${reason}`);
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
  } catch (error) {
    // Storage is best-effort here; losing the snapshot costs a resumed popup,
    // while throwing costs the whole run. Not throwing and not recording are
    // separate decisions though: a failed write leaves the persisted snapshot
    // stale, and a popup opened later reads it and stamps the quotes
    // `interrupted` — blaming MV3 suspension for a storage failure.
    warn('could not persist the run snapshot', error);
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
  if (!quote) return;
  if (quote.finishedAt) {
    // A late answer is still an answer. The probe can begin its final extract
    // one millisecond inside the deadline and spend arbitrary time there, so
    // this fires for a page that really did parse prices — and the quote is
    // sitting on a `probe-timeout` claiming nothing came back. Keeping the
    // evidence is the difference between "the vendor never answered" and "the
    // deadline is too short", which need opposite fixes.
    if (patch.report) quote.lateReport = patch.report;
    return;
  }
  Object.assign(quote, patch, { finishedAt: Date.now() });
  run.waiters.get(quoteId)?.();
  run.waiters.delete(quoteId);
}

/**
 * The only extraction branches a content script is allowed to claim.
 *
 * Same rule as PROBE_FAILURES below, for the same reason. `not-reached` and
 * `left-our-origins` are things only the background can know — it built them
 * from the tab after the probe went silent — so a page that could send one
 * would be forging the background's own testimony, and the popup would print
 * "no answer from the page" about a page that had just answered.
 */
const PROBE_PATHS = new Set<ProbeReport['path']>(['vendor-selectors', 'generic-sweep']);

/** How much of a page-supplied string is worth keeping. */
const MAX_REPORT_TEXT = 200;

/**
 * Take a report from a content script, keeping only what it may assert.
 *
 * Every field here is written by a page we do not control, so every field is
 * checked — guarding `path` alone left the other three trusted:
 *
 * - `finalPath` is truncated at the first `?` or `#`. "Path only, never the
 *   query string" is this repo's rule because the query carries the discount
 *   code and the user's itinerary, and it was enforced only for the report the
 *   *background* builds. The probe strips its own query honestly; a compromised
 *   page has no reason to, and the string is persisted and rendered.
 * - `title` and `finalPath` are capped. Unbounded, they go into
 *   `chrome.storage.session`, whose quota a hostile page could simply fill —
 *   and `publish()` swallows that failure into a warn, so the symptom would be
 *   a run that silently stops persisting.
 * - `offerCount` is clamped to a non-negative integer, having been rendered
 *   verbatim as "-7 offers".
 */
function sanitizeReport(report: ProbeReport | undefined): ProbeReport | undefined {
  if (!report) return undefined;
  const finalPath = String(report.finalPath ?? '')
    .split(/[?#]/)[0]!
    .slice(0, MAX_REPORT_TEXT);
  const count = Number(report.offerCount);
  return {
    finalPath,
    title: String(report.title ?? '').slice(0, MAX_REPORT_TEXT),
    offerCount: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
    // The observations above are the probe's own and worth having; only the
    // claim about *who* made them is refused, falling back to the branch the
    // probe would have used.
    path: PROBE_PATHS.has(report.path) ? report.path : 'generic-sweep',
  };
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
  const closing = run.windowId;
  if (closing !== null) {
    try {
      await chrome.windows.remove(closing);
    } catch (error) {
      // Usually already closed by the user. If it is not, the window is
      // minimised and holds a new-tab page, so nobody will ever see it to
      // close it by hand — which is worth a line.
      warn('could not close the background window', error);
    }
    run.windowId = null;
  }
  // After the close, not before: dropping the key first meant a failed close
  // left a window no future worker could ever find. And compared, not
  // unconditional — `windows.remove` is awaited IPC, and a run starting during
  // it writes its own id to this key. Same interleave `reapOrphanWindow`
  // guards; fixing one of two identical instances just moves the bug.
  await forgetWindowId(closing);
}

/** Drop the stored window id, but only if it is still the one we closed. */
async function forgetWindowId(closed: number | null): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    if (closed !== null && stored[WINDOW_KEY] !== closed) return;
    await chrome.storage.session.remove(WINDOW_KEY);
  } catch (error) {
    warn('could not forget the background window id', error);
  }
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // Usually already gone. If it is not, a tab is sitting open on a live
    // vendor site, which is the politeness contract broken.
    warn('could not close a probe tab', error);
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
      // Before the tab goes, not after: this is the only moment the background
      // can see what the probe was looking at.
      await describeSilentTab(quote, tabId);
      run.tabs.delete(tabId);
      run.retiredTabs.set(tabId, quote.id);
      await closeTab(tabId);
    }
    await publish();
  }
}

/**
 * Give a timed-out quote something to show, read from the tab itself.
 *
 * `probe-timeout` is the commonest failure and was the only one carrying no
 * evidence: the popup suppresses the whole evidence line when `report` is
 * absent, so the row said "no answer before the deadline" and nothing else.
 * A consent interstitial, a redirect to a country picker and a page that never
 * finished loading were indistinguishable — despite the background holding a
 * tab handle that answers the question.
 *
 * Path only, never the query string, exactly as the probe's own report is.
 */
async function describeSilentTab(quote: Quote, tabId: number): Promise<void> {
  if (quote.failure !== 'probe-timeout' || quote.report) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // `url` and `title` are populated only for a tab whose *current* URL
    // matches one of our host permissions. This extension holds no `tabs`
    // permission — PR #5 dropped it on purpose — so an undefined url means
    // only "we are not allowed to read this tab's address".
    //
    // That is as far as the inference goes, and no further. It is equally
    // consistent with a redirect off the vendor's site and with a load that
    // never committed — an `about:blank` that hung, a `chrome-error://` page
    // after a DNS or TLS failure. Both are leading causes of `probe-timeout`,
    // because both also mean the content script never ran. Reporting it as
    // "never navigated" was a confident wrong answer for the first; reporting
    // it as "left the vendor's site" would be the same mistake pointing the
    // other way. The report says what is known and the popup names both.
    const landed = tab.url ?? '';
    if (!landed) {
      quote.report = {
        finalPath: '',
        title: '',
        offerCount: 0,
        path: 'left-our-origins',
      };
      return;
    }
    let finalPath = '';
    try {
      finalPath = new URL(landed).pathname;
    } catch {
      // A url we can see but cannot parse. Rare, and an empty path reads as
      // "no path to show" rather than as a claim about where it went.
    }
    quote.report = {
      finalPath,
      title: (tab.title ?? '').slice(0, 200),
      offerCount: 0,
      path: 'not-reached',
    };
  } catch (error) {
    // The tab is already gone. Nothing to describe, and the quote keeps the
    // bare timeout it already had.
    warn('could not read the timed-out tab', error);
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
  const state: RunState = { plan, quotes };
  const run: ActiveRun = {
    state,
    tabs: new Map(),
    retiredTabs: new Map(),
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
          // A tab retired at its deadline can still be mid-extract. finishQuote
          // keeps only the report from an already-settled quote, so this can
          // add evidence and cannot change a verdict.
          const lateId = tabId === undefined ? undefined : active?.retiredTabs.get(tabId);
          const reported = sanitizeReport(message.report);
          if (active && quoteId === undefined && lateId !== undefined) {
            const late = sanitizeReport(message.report);
            if (late) finishQuote(active, lateId, { report: late });
            await publish();
          }
          if (active && quoteId !== undefined) {
            const best = bestOffer(message.offers);
            const quote = quoteFor(active, quoteId);
            finishQuote(active, quoteId, {
              status: best ? 'ok' : 'no-price',
              offers: message.offers,
              best,
              ...(reported ? { report: reported } : {}),
              ...(landedElsewhere(quote, reported) ? { suspect: 'landed-elsewhere' } : {}),
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
          // Same as PROBE_RESULT: evidence from a retired tab, nothing more.
          const lateId = tabId === undefined ? undefined : active?.retiredTabs.get(tabId);
          const reported = sanitizeReport(message.report);
          if (active && quoteId === undefined && lateId !== undefined && message.report) {
            const late = sanitizeReport(message.report);
            if (late) finishQuote(active, lateId, { report: late });
            await publish();
          }
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
              ...(reported ? { report: reported } : {}),
              // "no price because the link missed its search" and "no price
              // because the results page was empty" is exactly the distinction
              // this is for, and the evidence is already in hand.
              ...(landedElsewhere(failed, reported) ? { suspect: 'landed-elsewhere' } : {}),
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
/** Does this window still exist? Used to tell a failed close from a stale id. */
async function windowStillOpen(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

async function reapOrphanWindow(): Promise<void> {
  let windowId: number | undefined;
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    windowId = stored[WINDOW_KEY] as number | undefined;
  } catch (error) {
    warn('could not look for an orphaned window', error);
    return;
  }
  if (windowId === undefined) return;

  // A run that started while that lookup was in flight owns its own window, and
  // closing a live one would kill the race. Compared against the live run's own
  // id rather than bailing on `active !== null`: bailing left the key in place
  // for ensureWindow to overwrite moments later, so the *previous* worker's
  // orphan became unreachable forever — the leak this function exists to fix.
  if (active !== null && active.windowId === windowId) return;

  try {
    await chrome.windows.remove(windowId);
  } catch (error) {
    warn('could not close an orphaned window', error);
    // Almost always "already gone", which is fine — but not always, and the
    // two need opposite handling. Ask. If the window is still there, keeping
    // the id is the only way any later worker can find it again: it is
    // minimised and holds a new-tab page, so nobody will close it by hand.
    if (await windowStillOpen(windowId)) return;
  }
  // Compare-and-delete, not a bare delete. Everything above is awaited IPC, and
  // a run can start and claim its own window during it: the reaper reads
  // orphan id 3, `startRun` sets `active` while `windowId` is still null (the
  // create has not resolved), the guard above therefore passes, and by the time
  // `windows.remove(3)` returns the key holds the *live* run's id. Deleting it
  // then loses the only handle on a window that is about to be orphaned for
  // real — the exact leak this function exists to fix, caused by the function
  // itself.
  await forgetWindowId(windowId);
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
