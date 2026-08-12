import { buildDeepLink } from '../core/deeplinks.js';
import { bestOffer } from '../core/extract.js';
import type { BackgroundRequest, ProbeAssignment, StateMessage } from '../core/messages.js';
import { MAX_CONCURRENCY } from '../core/types.js';
import { recordRejected } from '../core/rejected-codes.js';
import { findVendor, VENDORS } from '../core/vendors.js';
import type {
  Candidate,
  Offer,
  PriceBasis,
  ProbeReport,
  Quote,
  QuoteFailure,
  RunState,
  SearchPlan,
  VendorId,
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
/**
 * How long a quote gets, unless its vendor asks for longer.
 *
 * Also a politeness setting, not only a correctness one: it bounds how long a
 * tab sits open on a vendor's site. That is why a vendor needing more asks for
 * it by name in `vendors.ts` rather than this number being raised for
 * everybody — Enterprise's 40s hydration should not slow Hertz down.
 */
const PROBE_TIMEOUT_MS = 45_000;
/** Time the background keeps in hand after the probe's own deadline passes. */
const PROBE_GRACE_MS = 5_000;
/** Breathing room between tab loads so we don't hammer a vendor. */
const STAGGER_MS = 750;
/**
 * How often to poke an extension API while a run is in flight.
 *
 * Chrome suspends an idle MV3 service worker at 30s, and a probe is silent for
 * far longer than that: it messages the background only when prices go stable
 * or `PROBE_TIMEOUT_MS` passes, so 45s of nothing is the normal case for a page
 * that never prices. The worker was therefore being killed mid-race — every
 * `setTimeout` deadline above dies with it, the probe tabs are left open for
 * the user to close by hand, and the next popup reads the stale snapshot and
 * stamps every quote `interrupted`.
 *
 * That last part is why this is worth a hack: `interrupted` is a diagnosis of
 * nothing, and it *replaces* the `probe-empty` and its report that would have
 * said what the page actually did. The commonest failure became the one with
 * no evidence.
 *
 * `setTimeout` does not keep a worker alive; an extension API call resets the
 * idle countdown, so the call below is made purely for its side effect and its
 * result is discarded. 20s leaves 10s of margin against the 30s limit.
 *
 * `chrome.alarms` is the tempting alternative and does not work here: its
 * minimum period is 30s, right at the boundary, and an alarm *restarts* a dead
 * worker rather than preventing the death — by which point `active` and every
 * in-flight quote are already gone.
 */
const KEEPALIVE_MS = 20_000;
/**
 * How long the keepalive holds the worker up **with no quote settling**.
 *
 * Deliberately not a wall clock on the whole run. As elapsed time this was
 * reachable by an ordinary race: break-even is roughly `13 x lanes` codes, so
 * 26 at the default concurrency of two, well inside the popup's own maximum of
 * 60. Past that the keepalive died mid-race and the remaining quotes came back
 * `interrupted` with their tabs left open — precisely the failure this whole
 * file is about, reintroduced by the guard meant to bound it.
 *
 * Measured as inactivity instead, it means what it was always for: a run that
 * is *stuck*. `runQuote` awaits `ensureWindow` and `chrome.tabs.create` with no
 * timeout around either, so a lane parked on a `windows.create` that never
 * settles has no deadline of its own; it also settles no quotes, so it trips
 * this. A healthy sixty-code race settles one every few seconds and never
 * comes close.
 *
 * Derived rather than a round ten minutes, so the two cannot drift: as
 * inactivity it only has to exceed the longest legitimate gap between two
 * settles, which is one lane's probe deadline plus its stagger — independent of
 * how many codes are in the run. Thirteen times that is ~10 minutes today and
 * shrinks automatically if the deadline does.
 *
 * **Derived from the longest deadline any vendor can ask for, not the default.**
 * Once `probeTimeoutMs` existed, basing this on the default would have made the
 * ceiling shorter than a single Enterprise quote is allowed to take: a run of
 * slow Enterprise quotes would trip its own inactivity guard and lose the
 * keepalive mid-race, which is the exact bug this constant was introduced to
 * prevent.
 *
 * Tripping it returns the worker to Chrome's ordinary suspension rules, which
 * is what shipped before this keepalive existed — the worst case is the old
 * behaviour, not a new failure.
 */
const KEEPALIVE_CEILING_MS = 13 * (maxProbeTimeoutMs() + STAGGER_MS);
/**
 * This vendor's probe deadline.
 *
 * `findVendor` rather than the throwing `getVendor`: a quote whose vendor is
 * somehow unknown should get the default budget and fail on its own merits, not
 * take the whole run down from inside a timing calculation.
 */
function probeTimeoutFor(vendor: VendorId): number {
  return findVendor(vendor)?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
}

/** The longest any single quote may take, across every vendor. */
function maxProbeTimeoutMs(): number {
  return VENDORS.reduce(
    (longest, vendor) => Math.max(longest, vendor.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
    PROBE_TIMEOUT_MS,
  );
}

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
  /** Vendor id -> tabs currently open at it, for `Vendor.maxLanes`. */
  vendorInFlight: Map<string, number>;
  /**
   * Lanes parked because every quote left belongs to a capped vendor.
   *
   * Woken when a quote releases its vendor slot, and — the part that matters —
   * on cancel. A parked lane that nothing wakes never returns, `Promise.all`
   * over the lanes never settles, and teardown never runs: the window stays
   * open and the popup sits on "Racing codes…" forever. That is the same shape
   * as every other stranded-teardown bug in this file.
   */
  laneWaiters: Set<() => void>;
}

/** Release every parked lane, so each can re-check the queue and the cancel flag. */
function wakeLanes(run: ActiveRun): void {
  for (const resolve of run.laneWaiters) resolve();
  run.laneWaiters.clear();
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
  // Remember only what the vendor itself said. `discount-missing` is our own
  // inference and is deliberately not recorded — see `rejected-codes.ts`.
  if (quote.failure === 'code-rejected') {
    // Fire and forget. Nothing waits for it: the popup re-reads this list when
    // the run finishes, and a write that lands after that broadcast costs one
    // wasted tab on the next run, which is the trade this whole store is built
    // on. Ordering the two was worth far less than the machinery it took.
    void recordRejected(
      chrome.storage.local,
      quote.candidate.vendor,
      quote.candidate.code,
      Date.now(),
    ).catch((error: unknown) => warn('could not remember a refused code', error));
  }
  // A settled quote is progress, and the keepalive ceiling measures the absence
  // of it rather than elapsed time. Without this, a race longer than the
  // ceiling loses its keepalive part-way through and its remaining quotes come
  // back `interrupted` with their tabs left open — the exact symptom this file
  // exists to prevent, reachable at 26 codes on the default concurrency of two.
  extendKeepAlive();
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
 *
 * The quota argument above is only true alongside `sanitizeOffers`. Capping a
 * title at 200 characters closes nothing on its own while the same message's
 * `offers` array goes to the same storage unbounded — this docstring claimed
 * the threat was handled for a while when the larger half of it was not.
 */
/**
 * How many offers one page may contribute.
 *
 * Generous by an order of magnitude: the longest real results page in the
 * fixtures carries tens, not hundreds. This is a bound on a hostile page, not a
 * judgement about a legitimate one.
 */
const MAX_OFFERS = 200;

const PRICE_BASES = new Set<PriceBasis>(['total', 'per-day', 'unknown']);

/**
 * Take the offers from a content script, keeping only what is usable as one.
 *
 * Same doctrine as `sanitizeReport`, applied to the field that carries the most
 * page-supplied bytes by far. Every one of these is persisted to
 * `chrome.storage.session` and `label` is rendered in the popup, so an
 * unchecked array is both the quota hole `sanitizeReport`'s docstring claimed
 * to have closed and the widest surface a vendor page has on this extension.
 *
 * An entry with no finite amount is dropped rather than coerced: `bestOffer`
 * ranks on that number, and a `NaN` compares false against everything, which is
 * a silent way to lose a race rather than to fail one.
 */
function sanitizeOffers(offers: unknown): Offer[] {
  if (!Array.isArray(offers)) return [];
  const clean: Offer[] = [];
  for (const raw of offers) {
    if (clean.length >= MAX_OFFERS) break;
    if (!raw || typeof raw !== 'object') continue;
    const offer = raw as Partial<Offer>;
    const amount = Number(offer.amount);
    if (!Number.isFinite(amount)) continue;
    clean.push({
      label: typeof offer.label === 'string' ? offer.label.slice(0, MAX_REPORT_TEXT) : null,
      amount,
      currency: String(offer.currency ?? 'USD').slice(0, 8),
      basis: PRICE_BASES.has(offer.basis as PriceBasis) ? (offer.basis as PriceBasis) : 'unknown',
    });
  }
  return clean;
}

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
 * The rule, rather than a list to be maintained twice: a page may claim only
 * what it is the sole witness to. Every other member of `QuoteFailure` is the
 * background's own knowledge, and a page sending one is not offering a
 * diagnosis but forging ours. `cancelled` and `tab-closed` are the dangerous
 * shapes because they read as plausible and misattribute the failure to the
 * user — but enumerating the excluded ones here is what let this comment and
 * CLAUDE.md drift apart, so the rule is the specification.
 *
 * `form-fill`, `form-submit`, `code-rejected` and `discount-missing` join here,
 * and the reason is the rule rather than the calendar: National is `searchable: true` with a
 * registered driver, so a run really does route to code that emits all three,
 * and each is something only the page can witness — whether a field took a
 * value, whether a submission produced results, whether the vendor named the
 * account the code belongs to, and whether the discount was on the answer. They
 * were held out while no *reachable* emitter existed, because a code admitted
 * early can only ever arrive forged.
 *
 * `code-rejected` carries a consequence the others do not, and it is worth
 * stating beside the allowlist rather than only in `rejected-codes.ts`: it is
 * **persisted**, so a script on one of the matched hosts can retire a code from
 * future runs. That is a deliberate trade — the alternative is re-racing a
 * refusal every run — and it is bounded by `MAX_ENTRIES`, visible in the popup
 * and clearable in one click. It is also the first page-influenced state this
 * extension keeps, which is why the recording is restricted to the vendor's own
 * sentence and never to anything we merely inferred.
 */
const PROBE_FAILURES = new Set<QuoteFailure>([
  'extract-threw',
  'probe-empty',
  // Only the content script can compare what the page rendered against the trip
  // it was assigned, so this satisfies the rule above. Unlike `form-fill` it has
  // an emitter today, which is the whole reason it is admitted now.
  'wrong-trip',
  'form-fill',
  'form-submit',
  'code-rejected',
  'discount-missing',
]);

/**
 * Did the deep link land somewhere other than the search we asked for?
 *
 * README is explicit that these URLs are reverse-engineered and expected to
 * rot, and the failure is silent: a vendor home page still shows "from $19/day",
 * so the quote comes back `ok` and simply wins. The site root is the one
 * unambiguous tell — it is never a results page — so that is all this claims.
 *
 * No longer blind for avis, whose builder targets
 * /en/reservation/vehicle-availability, so a landing on the root is the same
 * unambiguous tell it is everywhere else. Budget, enterprise and sixt are out
 * of scope entirely — they build no URL and produce no candidate. National is
 * not: it builds one (`confidence: 'driven'`, the page its form lives on) and
 * races, but its driver checks the results page itself, which is a stronger
 * signal than this flag can give.
 *
 * Still blind to a link that reaches a real page which is not the search we
 * asked for. Sixt used to be the live example and is `searchable: false` now;
 * the remaining ones are the three hotel builders, still `best-effort` and
 * never checked against a live site. Detecting it needs a per-vendor "this is
 * what a results page looks like" signal — which National's driver has, in
 * `verifyResults`, and no deep-linked vendor does.
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

/**
 * Thrown when a run is cancelled while a lane is waiting for its window.
 *
 * Distinct from the tab-open failures around it because it is not a failure:
 * the cancel path has already settled every unfinished quote as `cancelled`,
 * and reporting `tab-open` over the top of that would blame the extension for
 * something the user did.
 */
class RunCancelled extends Error {
  constructor() {
    super('run cancelled while opening the background window');
  }
}

async function ensureWindow(run: ActiveRun): Promise<number> {
  if (run.windowId !== null) return run.windowId;

  // A cancel that lands while a lane is suspended must not be able to re-arm
  // this. `runQuote` checks `run.cancelled` before and after this call, but the
  // `await publish()` between them is a suspension point: a lane parked there
  // when `cancelRun` arrives resumes to find `windowPromise` nulled by
  // `closeWindow` and memoises a *second* window -- after the run was cancelled
  // and its first window closed. Nothing in this worker closes that one. The
  // run is already torn down, and `reapOrphanWindow` only runs at startup, so
  // it is the familiar shape: a minimised window holding a new-tab page,
  // invisible to the user, with no handle on it. Pre-existing on `main`, and
  // the same family as the double-run guard and the orphan-window fixes.
  if (run.cancelled) throw new RunCancelled();

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
    // Deliberately no second cancel check here, though one was written first.
    // A cancel landing while Chrome is still opening the window gets past the
    // guard above, and `closeWindow` has already run -- but assigning the id
    // below is what makes the window findable, and startRun's own teardown
    // closes it on the way out. Throwing instead would leave `run.windowId`
    // null and orphan the window for good, which is what the first version did
    // until its mutant was checked. The "closes a window Chrome finished
    // opening after the cancel landed" test covers this path.
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
      // And worth keeping the id: it is the only handle any later worker has
      // on it. `reapOrphanWindow` has had this check since it was written;
      // this half was claimed to be identical and was not, so a failed close
      // here still leaked a window permanently.
      if (await windowStillOpen(closing)) {
        run.windowId = null;
        return;
      }
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
  // Nothing was closed, so there is nothing to forget. Without this the
  // function contradicted its own docstring and wiped a *foreign* orphan id —
  // reachable from a run that never opened a window at all, which is what an
  // empty candidate list or a cancel landing before `ensureWindow` produces.
  if (closed === null) return;
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    if (stored[WINDOW_KEY] !== closed) return;
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
    run.deadlines.set(
      quote.id,
      Date.now() + probeTimeoutFor(quote.candidate.vendor) - PROBE_GRACE_MS,
    );

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
    // A RunCancelled reaching here needs no special case: cancelRun settles
    // every unfinished quote before any lane resumes, and finishQuote returns
    // early for a settled quote, so the `tab-open` patch below is dropped. An
    // `instanceof` check here was written first and then removed as dead --
    // it could be deleted with the suite green because finishQuote was already
    // doing the work. The property it was protecting is real and is pinned by
    // "does not report a cancelled quote as a tab-open failure".
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

/**
 * Take the first quote whose vendor has a free slot, claiming that slot.
 *
 * Skips past a capped vendor rather than blocking on it, so one National quote
 * in flight does not stall a lane that could be pricing Hertz. Synchronous on
 * purpose: read-and-claim happens with no `await` between, which is what stops
 * two lanes both seeing the last free slot. An async guard is not a guard, and
 * this file already records `cancelRun()` failing at exactly that.
 */
function takeNext(run: ActiveRun, queue: Quote[]): Quote | null {
  for (let i = 0; i < queue.length; i += 1) {
    const quote = queue[i]!;
    const vendor = quote.candidate.vendor;
    // An unknown vendor is uncapped rather than skipped: `findVendor` tolerates
    // an id the registry has dropped, and a quote nothing will ever take is a
    // lane parked forever.
    const cap = findVendor(vendor)?.maxLanes ?? Infinity;
    if ((run.vendorInFlight.get(vendor) ?? 0) < cap) {
      queue.splice(i, 1);
      run.vendorInFlight.set(vendor, (run.vendorInFlight.get(vendor) ?? 0) + 1);
      return quote;
    }
  }
  return null;
}

async function worker(run: ActiveRun, queue: Quote[]): Promise<void> {
  for (;;) {
    if (run.cancelled) return;
    const next = takeNext(run, queue);
    if (!next) {
      // Nothing left for anyone: this lane is done.
      if (queue.length === 0) return;
      // Work remains, but all of it belongs to vendors at their cap. Park until
      // a slot frees rather than spin — and rather than return, which would
      // quietly drop those quotes on the floor with the run reported complete.
      await new Promise<void>((resolve) => run.laneWaiters.add(resolve));
      // The stagger lives at the tail of this loop, which a `continue` skips.
      // Without this the capped vendors — the ones whose sites keep session
      // state, and so the ones most likely to rate-limit — are exactly the
      // vendors whose consecutive tabs open with no gap at all, since each one
      // starts the instant the previous releases its slot.
      await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
      continue;
    }
    try {
      await runQuote(run, next);
    } finally {
      // In a finally because a throw here would otherwise leak the slot, and a
      // leaked slot on a vendor capped at one parks every lane for the rest of
      // the run.
      const vendor = next.candidate.vendor;
      run.vendorInFlight.set(vendor, Math.max(0, (run.vendorInFlight.get(vendor) ?? 1) - 1));
      wakeLanes(run);
    }
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
  // answering it from `active` — and `active` is never nulled, so after an
  // earlier run has finished it still points at *that* one. The refused caller
  // received a state carrying `finishedAt`, which the popup reads as "no run in
  // progress" and re-arms the button on, defeating the guard it had just
  // passed. On a fresh worker the refusal was fine: `active` is assigned before
  // the catch body runs a microtask later.
  if (startingRun) return startingRun;
  const pending = (startingRun = beginRun(plan));
  try {
    return await pending;
  } finally {
    if (startingRun === pending) startingRun = null;
  }
}

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** When the current keepalive gives up. Refreshed by every run that starts. */
let keepAliveUntil = 0;

/**
 * Push the ceiling out because a quote settled.
 *
 * The null check is not about late replies — a reply for an already-settled
 * quote returns from `finishQuote` before reaching here. What it defends is a
 * lane settling a quote *after* the ceiling has already fired inside a run
 * that is still going: without it, progress would resurrect the keepalive the
 * ceiling had just given up on, and a wedged run with one slow survivor could
 * hold the worker indefinitely.
 */
function extendKeepAlive(): void {
  if (keepAliveTimer === null) return;
  keepAliveUntil = Date.now() + KEEPALIVE_CEILING_MS;
}

/**
 * Hold the worker resident for a run, and (re)set its inactivity ceiling.
 *
 * Idempotent, so a second run starting while one is winding down cannot leave
 * two intervals running.
 */
function startKeepAlive(): void {
  // Refreshed unconditionally, *before* the idempotence check, and that
  // ordering is the whole point. Holding the deadline in a closure captured
  // when the interval was created meant a second run inherited the first run's
  // remaining time: run A wedges on `windows.create` so its teardown never
  // fires, the user cancels, and run B nine minutes later finds a live timer,
  // returns early, and loses its keepalive sixty seconds in — the original bug,
  // silently, for the second run of the session. The same thing happens inside
  // `STAGGER_MS` of a cancel-then-restart, where A's teardown skips
  // `stopKeepAlive` on the `active === run` guard and B inherits.
  keepAliveUntil = Date.now() + KEEPALIVE_CEILING_MS;
  if (keepAliveTimer !== null) return;
  keepAliveTimer = setInterval(() => {
    if (Date.now() >= keepAliveUntil) {
      // MV3 suspension used to be the backstop for a wedged run. `runQuote`
      // awaits `ensureWindow` and `chrome.tabs.create` with no timeout around
      // either — the probe deadline only starts once the tab exists — so a lane
      // parked on a `windows.create` that never settles ended when Chrome
      // reclaimed the worker at 30s. Holding the worker up removed that, and
      // would otherwise leave a minimised window open indefinitely while the
      // popup looks idle. Past the ceiling we hand the decision back to Chrome,
      // which is exactly the behaviour that shipped before this keepalive.
      //
      // Worth a line, because the only other evidence is the absence of pings
      // in a console nobody is watching. No URL and no code, per warn()'s rule.
      warn('keepalive ceiling reached; letting the worker suspend', 'run exceeded the ceiling');
      stopKeepAlive();
      return;
    }
    // Deliberately ignoring the result, and deliberately swallowing failure:
    // this call exists only to reset Chrome's idle countdown, and a rejected
    // keepalive is not something the user can act on. warn() is reserved for
    // failures that cost the run something.
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, KEEPALIVE_MS);
}

function stopKeepAlive(): void {
  if (keepAliveTimer === null) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function beginRun(plan: SearchPlan): Promise<RunState> {
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
    vendorInFlight: new Map(),
    laneWaiters: new Set(),
  };
  active = run;
  startKeepAlive();

  let queue: Quote[];
  let lanes: number;
  try {
    await publish();
    queue = quotes.filter((q) => !q.finishedAt);
    lanes = Math.max(1, Math.min(plan.concurrency, MAX_CONCURRENCY));
  } catch (error) {
    // The teardown below is the only thing that stops the interval, and it does
    // not exist yet — so anything that throws between starting the keepalive
    // and installing it would pin the worker resident for the rest of the
    // browser session, with `active` pointing at a run that never tears down.
    // `publish` is documented as unable to throw, but this file already carries
    // a long comment about a publish() rejection escaping and skipping
    // teardown, which was real once.
    stopKeepAlive();
    throw error;
  }

  void (async () => {
    try {
      await Promise.all(Array.from({ length: lanes }, () => worker(run, queue)));
    } finally {
      // In a finally so that a lane throwing cannot skip teardown and strand
      // the run with its window open and the popup showing "Racing codes…".
      if (active === run) {
        // Stamped before the awaits, not between them. The `finally` and the
        // outer `.catch` exist because those awaits are believed able to
        // reject — and `active` is never nulled, so a run that reached this
        // block without a `finishedAt` is reported live by `currentState()`
        // for the life of the worker: the popup stuck on "Racing codes…" with
        // Run disabled and no way back. It also closes the window where every
        // quote is settled but `GET_STATE` still answers "running".
        //
        // Deleting this line — moving the stamp back between the awaits —
        // passes the whole suite, and that is recorded rather than hidden:
        // reaching it needs `closeWindow` to reject, and it is fully
        // try/caught today, so a test would have to add a failing
        // `windows.remove` to the chrome fake to construct a state the code
        // cannot currently be in. The line costs nothing and restores the
        // guarantee the original ordering had.
        run.state.finishedAt = Date.now();
        try {
          await closeWindow(run);
          await publish();
        } finally {
          // Last, after the closes and the final publish, so teardown itself is
          // still covered by a resident worker — the same ordering `cancelRun`
          // has always used, and for the same reason. `finishedAt` lives only
          // in memory until `publish` persists it, so a reclaim before that
          // loses the finished snapshot and the popup falls back to
          // `reapInterrupted`. It mattered less when nothing here awaited I/O;
          // awaiting a storage write between the two is what made the gap worth
          // closing.
          //
          // In a `finally`, because moving it last silently traded away the
          // unconditional stop it used to have as the block's first statement.
          // Any of those three rejecting — `publish` calls `broadcast`, whose
          // `chrome.runtime.sendMessage` can *throw* synchronously on an
          // invalidated context, which its own `.catch` does not cover — left
          // the interval poking every 20s for the rest of the ceiling with no
          // run in progress. That is the failure `beginRun`'s own
          // `catch { stopKeepAlive(); throw }` above exists for.
          //
          // Re-checked, not covered by the block's own `active === run`: that
          // test is now three awaits old, and a newer run starting inside them
          // has its own keepalive to stop out from under. Exactly the
          // regression `cancelRun` records below, which is why it re-checks
          // too.
          //
          // Deleting that guard passes the whole suite, and that is recorded
          // rather than hidden: reaching it needs a second run to start
          // *inside* teardown's storage wait, and `startRun` cancels the active
          // run first — which awaits the same write this one is parked on. Kept
          // because the reasoning is `cancelRun`'s, where the unguarded version
          // was a real measured regression, and because a guard that costs one
          // comparison is not worth trading for a test that would have to be
          // built out of that interleaving.
          if (active === run) stopKeepAlive();
        }
      }
    }
  })().catch((error: unknown) => {
    // Nothing awaits this IIFE, so a throw out of teardown is an unhandled
    // rejection — the one failure in this file that no `Quote.failure` can
    // carry, because by here the run is over and every quote is settled. The
    // `finally` above has already stopped the keepalive and the run has been
    // torn down; all that is left is to say it happened rather than let the
    // runtime report it with no context.
    warn('teardown failed after the run finished', error);
  });

  return state;
}

/**
 * What the popup should be shown: the live run, or the settled snapshot.
 *
 * One caller now that the clear no longer goes through the worker, and kept
 * separate anyway: `active?.state ?? null` is the tempting shorthand and it is
 * wrong after a restart, where it says "no run" about one the user can still
 * see on screen.
 */
async function currentState(): Promise<RunState | null> {
  if (active) return active.state;
  // No active run, so anything unfinished in the snapshot belongs to a worker
  // that was suspended. Settle it before the popup sees it.
  const state = reapInterrupted(await loadPersisted());
  if (state) await persist(state).catch(() => {});
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
  // Lanes parked on a vendor cap are waiting for a slot that will never free.
  //
  // Deliberately not claimed as a stranded-teardown bug: `cancelRun` closes the
  // window and stamps `finishedAt` itself, so today a parked lane leaks a lane
  // promise that never settles rather than leaving a window open — which is why
  // deleting this line still passes `tests/vendor-lane-cap.test.ts`, and that is
  // recorded there rather than papered over. It stays because the leak is real,
  // and because the natural next refactor is to let the lanes promise drive
  // teardown, at which point an unwoken lane *would* hang the run.
  wakeLanes(run);
  for (const tabId of run.tabs.keys()) await closeTab(tabId);
  run.tabs.clear();
  run.deadlines.clear();

  await closeWindow(run);

  run.state.finishedAt ??= Date.now();
  await publish();
  // Last, after the closes and the final publish, so teardown itself is still
  // covered by a resident worker.
  //
  // Needed because cancelling settles every quote, and settling extends the
  // ceiling. Without this, cancelling a run whose lane is wedged on
  // `windows.create` — the case where teardown never fires, so nothing else
  // ever stops the interval — bought the worker another full ceiling *after*
  // the cancel, with the window closed and the popup idle. Measured at 27
  // further pokes against 2 before the inactivity change, so this is a
  // regression that arrived with it rather than a pre-existing gap.
  //
  // Guarded on `active === run` for the same reason the teardown block is, and
  // the unguarded version was a regression of its own: `run` is captured at the
  // top of this function and three suspension points follow, so a `cancelRun`
  // that started earlier can resume *after* a newer run is live and stop its
  // keepalive — zero pokes, total silence, the original bug. Not reachable by
  // clicking today, because Cancel is hidden while a start is in flight, but
  // reachable through the message protocol and invisible when it happens.
  if (active === run) stopKeepAlive();
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
          sendResponse({ type: 'RUN_STATE', state: await currentState() } satisfies StateMessage);
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
            trip: active.state.plan.trip,
            code: quote.candidate.code,
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
            // Sanitize before ranking, not after: bestOffer must see the same
            // list that gets stored, or the popup shows a winner drawn from
            // offers it never received.
            const offers = sanitizeOffers(message.offers);
            const best = bestOffer(offers);
            const quote = quoteFor(active, quoteId);
            finishQuote(active, quoteId, {
              status: best ? 'ok' : 'no-price',
              offers,
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
