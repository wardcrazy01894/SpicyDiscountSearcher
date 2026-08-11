import {
  allCompanies,
  buildCandidates,
  codeReaches,
  countCodesFor,
  interleaveByVendor,
  searchCompanies,
} from '../core/codes.js';
import {
  cheapestComparable,
  classMatrix,
  estimatedTotal,
  primaryGroup,
  orderForDisplay,
  savings,
  unrankedQuotes,
} from '../core/compare.js';
import { buildDeepLink } from '../core/deeplinks.js';
import {
  loadRejected,
  rejectionKey,
  rejectionSet,
  type RejectedCode,
} from '../core/rejected-codes.js';
import { MAX_CONCURRENCY } from '../core/types.js';
import type { PopupRequest, StateMessage } from '../core/messages.js';
import type {
  Candidate,
  Category,
  PriceBasis,
  ProbeReport,
  Quote,
  QuoteFailure,
  RunState,
  SearchPlan,
  Trip,
  VendorId,
} from '../core/types.js';
import { findVendor, searchableVendors, vendorsFor } from '../core/vendors.js';

const FORM_STATE_KEY = 'popupForm';

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  return node;
}

const form = el<HTMLFormElement>('#trip-form');
const tagline = el<HTMLParagraphElement>('#tagline');
const carFields = el<HTMLElement>('#car-fields');
const hotelFields = el<HTMLElement>('#hotel-fields');
const vendorChips = el<HTMLElement>('#vendor-chips');
const companySearch = el<HTMLInputElement>('#company-search');
const companyList = el<HTMLElement>('#company-list');
const maxCodesInput = el<HTMLInputElement>('#max-codes');
const concurrencyInput = el<HTMLInputElement>('#concurrency');
const planSummary = el<HTMLParagraphElement>('#plan-summary');
const runBtn = el<HTMLButtonElement>('#run-btn');
const cancelBtn = el<HTMLButtonElement>('#cancel-btn');
const results = el<HTMLElement>('#results');
const savingsBox = el<HTMLElement>('#savings');
const quotesList = el<HTMLOListElement>('#quotes');
const avisCaptchaBtn = el<HTMLButtonElement>('#avis-captcha-btn');
const budgetCaptchaBtn = el<HTMLButtonElement>('#budget-captcha-btn');
const rejectedNote = el<HTMLElement>('#rejected-note');
const rejectedCount = el<HTMLElement>('#rejected-count');
const rejectedClear = el<HTMLButtonElement>('#rejected-clear');

interface UiState {
  category: Category;
  vendors: Set<VendorId>;
  companies: Set<string>;
  /** Mirrors the background's run state, so plan edits can't re-arm Run. */
  running: boolean;
  /**
   * A START_RUN sent but not yet answered.
   *
   * `running` only becomes true when a reply lands, so between the click and
   * the background answering — a window create and a storage write — every
   * `refreshPlan` trigger re-armed the button: a max-codes keystroke, a vendor
   * chip, a company checkbox. That is the window a double-click sends its
   * second START_RUN in, and it is also why "the button stays disabled after a
   * failed send" was not true before this flag existed.
   */
  pendingStart: boolean;

  /**
   * A START_RUN whose sendMessage rejected, and the popup cannot recover from.
   *
   * `pendingStart` correctly keeps Run disabled — a rejection does not prove
   * non-delivery, so re-arming would offer a second race on top of one that may
   * already be opening tabs. But the *explanation* lived only in
   * `planSummary.textContent`, which every `refreshPlan` overwrites: a vendor
   * chip, a company checkbox, a max-codes keystroke or a category tab all wiped
   * it and cleared `is-warning`, leaving a dead button and no reason for it.
   * Sticky, so refreshPlan can put the message back instead of over it.
   */
  sendFailed: boolean;
  /**
   * "Try them again" was pressed and the codes were still refused afterwards.
   *
   * Read only by `renderRejectedNote`, which draws it beside that button, and
   * retired by any fresh reading of the list — see `reloadRejected`. It is a
   * statement about the refusals the popup held at the moment of the clear, so
   * it must not outlive them.
   */
  clearFailed: boolean;
  /**
   * Codes a vendor has refused, loaded once at boot.
   *
   * Held in UI state rather than read per keystroke: `refreshPlan` runs on every
   * chip, checkbox and keypress, and a storage read on each would be a lot of
   * async for a list that only changes when a run settles.
   */
  rejected: RejectedCode[];
}

const ui: UiState = {
  category: 'car',
  vendors: new Set<VendorId>(),
  companies: new Set<string>(),
  running: false,
  pendingStart: false,
  sendFailed: false,
  clearFailed: false,
  rejected: [],
};

/**
 * Whether `main()` has established a selection to draw.
 *
 * The RUN_STATE listener is registered at module scope, so a broadcast can
 * arrive before `restoreForm` and `setCategory` have run.
 */
let booted = false;

/** Kept in one place because refreshPlan and applyReply both write it. */
const SEND_FAILED_MESSAGE = 'Could not reach the extension background. Reopen the popup to retry.';
/**
 * Deliberately does not name a cause.
 *
 * It covers a send that failed, a reply that never came, *and* the worker
 * replying normally while its own bounded wait gave up on a slow write — in the
 * last of which the background was reached and is still going to clear them.
 * "Not yet" is the only thing true of all three.
 */
const CLEAR_FAILED_MESSAGE = 'Those codes have not been cleared yet. Try again in a moment.';

/**
 * The most codes one run may race.
 *
 * Every code is a real tab on a real vendor site, so this is the run's size
 * rather than a display limit — and there is no priority ordering underneath
 * it. `interleaveByVendor` spreads the candidates across vendors and companies
 * so that *truncating* is fair, not so that the best codes come first; nothing
 * here knows which code will win. Whatever this number cuts off is cut off
 * arbitrarily, which is the argument for it being generous.
 *
 * 100 covers every car code there is — 63 across Hertz, Avis and National with
 * all three selected — so a car run can be exhaustive. Hotels still cannot:
 * there are 401, and Hilton alone has 279. Raising it far enough for those is a
 * different conversation, because it is also 401 tabs.
 *
 * The previous ceiling was 60, which bound even a full car run, and it carried
 * no recorded reason anywhere in the repo.
 */
const MAX_CODES = 100;

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * An empty vendor selection means "no preference", so it is filled in.
 *
 * Deliberately *not* inside `renderVendorChips`, where it lived until this
 * render gained call sites that are not the user establishing a selection —
 * clearing the refusal list, and a run finishing. Unticking every chip leaves
 * `ui.vendors` empty with the boxes unticked (the change handler does not
 * re-render), so the fill would have re-ticked the whole row under a user who
 * had just cleared it, reverting a choice they made and leaving `ui.vendors`
 * disagreeing with the saved form until the next save. Filling belongs to the
 * moments a selection is established, not to drawing one.
 *
 * Which is a narrower guarantee than "an untick survives", and deliberately so.
 * Clicking the already-active category tab still re-fills, and so does
 * reopening the popup, because `restoreForm` reads a saved `vendors: []` as a
 * selection and this then replaces it. Both are the behaviour that shipped
 * before any of this; an empty selection is read as "no preference" rather than
 * "race nothing", and making it persist is a different decision from stopping a
 * re-render reverting it.
 */
function defaultVendorsIfEmpty(): void {
  if (ui.vendors.size > 0) return;
  for (const vendor of vendorsFor(ui.category)) ui.vendors.add(vendor.id);
}

function renderVendorChips(): void {
  const vendors = vendorsFor(ui.category);
  const refused = rejectionSet(ui.rejected);

  vendorChips.replaceChildren(
    ...vendors.map((vendor) => {
      const label = document.createElement('label');
      label.className = ui.vendors.has(vendor.id) ? 'chip is-on' : 'chip';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ui.vendors.has(vendor.id);
      box.addEventListener('change', () => {
        if (box.checked) ui.vendors.add(vendor.id);
        else ui.vendors.delete(vendor.id);
        label.classList.toggle('is-on', box.checked);
        // The company list is a function of the vendor selection — which
        // companies match, which vendors each row is labelled with, and which
        // of the three empty-state messages applies — and none of it redrew
        // when the selection changed. Unticking Avis and Hertz to leave only
        // National, which is this PR's own motivating scenario, left every Avis
        // and Hertz company on screen with their old labels until some
        // unrelated trigger rebuilt the list.
        renderCompanyList();
        refreshPlan();
        void saveForm();
      });

      // What this vendor would actually race, which is the number the plan line
      // reports and the whole reason this is not just `countCodesFor(id)`: the
      // chip said 19 while the run did 14, because the plan learned to skip
      // refused codes and the count had not.
      const raceable = countCodesFor(vendor.id, refused);
      // Each call is a full pass over every record in the database, and with
      // nothing refused — the overwhelmingly common case — the second one is
      // guaranteed to return what the first did.
      const total = refused.size === 0 ? raceable : countCodesFor(vendor.id);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(raceable);
      if (total > raceable) {
        // The smaller number alone is its own confusion — a vendor you know has
        // nineteen codes quietly showing fourteen. The chip carries the
        // difference rather than swallowing it, and the standing note below the
        // form is the clickable way to put them back.
        label.title = `${total} codes, ${total - raceable} refused by the vendor and no longer raced`;
      }

      label.append(box, document.createTextNode(vendor.label), count);
      return label;
    }),
  );
}

/**
 * "3 selected · clear" — the only handle on a selection you cannot see.
 *
 * The list renders at most 60 matches, so a company picked via the search box
 * is invisible once the box is cleared, and a stale saved selection can leave
 * the plan empty with no checkbox anywhere to untick.
 */
function selectionSummary(): HTMLElement | null {
  if (ui.companies.size === 0) return null;
  const row = document.createElement('p');
  row.className = 'empty selection';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'linklike';
  clear.textContent = 'clear';
  clear.addEventListener('click', () => {
    ui.companies.clear();
    renderCompanyList();
    refreshPlan();
    void saveForm();
  });
  row.append(`${ui.companies.size} selected · `, clear);
  return row;
}

/** Keep the count current without re-rendering the list out from under a click. */
function syncSelectionSummary(): void {
  const existing = companyList.querySelector('.selection');
  if (ui.companies.size === 0) {
    existing?.remove();
    return;
  }
  if (existing?.firstChild) {
    existing.firstChild.textContent = `${ui.companies.size} selected · `;
    return;
  }
  const fresh = selectionSummary();
  if (fresh) companyList.prepend(fresh);
}

/** Nothing matched because of the vendor picker or the search box. */
function emptyBySelection(query: string): string {
  return query
    ? `No company matching "${query}" has a code for these vendors.`
    : 'Pick at least one vendor.';
}

/** Nothing matched because every code that would have was refused. */
function emptyByRefusal(query: string): string {
  const what = query ? `Every code matching "${query}" at these vendors` : 'Every code here';
  // Names the button below the form rather than describing the state and
  // stopping, because the state is undoable and the undo is two lines away.
  return `${what} was refused by the vendor. Use "try them again" to re-ask.`;
}

/**
 * Which of the two filters emptied the list.
 *
 * The same predicate without the refusal check answers it, and the answer
 * decides between two opposite diagnoses: "you have picked nothing" and "the
 * vendors said no to everything". Reachable — select only National, let its
 * codes be refused over a few runs, and the plan line correctly says every code
 * was refused while this list told the user to pick a vendor they had already
 * picked.
 */
function emptyReason(query: string, vendors: VendorId[]): string {
  const reachesAnyway =
    vendors.length > 0 &&
    searchCompanies(query).some((company) =>
      company.codes.some((code) => !!code.code && vendors.some((v) => codeReaches(code.vendor, v))),
    );
  return reachesAnyway ? emptyByRefusal(query) : emptyBySelection(query);
}

function renderCompanyList(): void {
  const query = companySearch.value;
  const vendors = [...ui.vendors];
  // `codeReaches`, not `vendors.includes(code.vendor)`. The inline version was
  // the same mistake the vendor chip's count made: a code filed under one brand
  // can be raced at another, and every National code is filed under Enterprise.
  // Selecting National alone therefore hid the eight companies whose only car
  // code is an Enterprise contract id — `Michigan State University`,
  // `Purdue / Big TEN`, `UNION Bank/MUFG` and `University of Maryland` among
  // them, which are precisely the companies README says disappeared when these
  // vendors went unsearchable.
  const refused = rejectionSet(ui.rejected);
  const raceableAt = (code: { code: string | null; vendor: VendorId }, vendor: VendorId): boolean =>
    !!code.code &&
    codeReaches(code.vendor, vendor) &&
    !refused.has(rejectionKey(vendor, code.code));
  const found = searchCompanies(query);
  const matches = found.filter((company) =>
    company.codes.some((code) => vendors.some((v) => raceableAt(code, v))),
  );
  // A company the user has ticked stays listed even when it has nothing left to
  // race. Otherwise the row vanishes while the slug stays in `ui.companies` and
  // in the saved form, so the plan reads "No codes left to race — all 1 were
  // refused" with no checkbox anywhere to untick: the only ways out are the
  // blanket `clear`, which drops every company, or putting all the refusals
  // back.
  //
  // Kept apart from `matches` rather than folded into it, because everything
  // below asks "is there anything to race" and a stranded row is not an answer
  // to that. Merged, it suppressed the empty-list branch entirely — so
  // unticking every vendor chip with a company still selected showed no rows'
  // worth of plan and never said `Pick at least one vendor`, which was exactly
  // the diagnosis.
  const raceableSlugs = new Set(matches.map((company) => company.slug));
  const stranded = found.filter(
    (company) => ui.companies.has(company.slug) && !raceableSlugs.has(company.slug),
  );
  const selected = selectionSummary();

  if (matches.length === 0 && stranded.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyReason(query, vendors);
    // Still offer the escape hatch — an empty list is exactly when a stale
    // selection has stranded the plan.
    companyList.replaceChildren(...(selected ? [selected, empty] : [empty]));
    return;
  }

  // The empty-list message still belongs above the stranded rows when there is
  // genuinely nothing to race — they are an escape hatch, not a plan.
  const emptyNote = document.createElement('p');
  emptyNote.className = 'empty';
  emptyNote.textContent = matches.length === 0 ? emptyReason(query, vendors) : '';

  // Long lists make the popup crawl; the search box is how you reach the rest.
  const shown = [...matches, ...stranded].slice(0, 60);
  companyList.replaceChildren(
    ...(selected ? [selected] : []),
    ...(matches.length === 0 ? [emptyNote] : []),
    ...shown.map((company) => {
      const row = document.createElement('label');
      row.className = 'company';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ui.companies.has(company.slug);
      box.addEventListener('change', () => {
        if (box.checked) ui.companies.add(company.slug);
        else ui.companies.delete(company.slug);
        syncSelectionSummary();
        refreshPlan();
        void saveForm();
      });

      const name = document.createElement('span');
      name.textContent = company.name;

      const vendorList = document.createElement('span');
      vendorList.className = 'vendors';
      // Which of the *selected* vendors this company can actually be raced at,
      // by the same `codeReaches` rule as the filter above and the chip counts.
      //
      // It used to be `vendors.includes(c.vendor)`, and it was the last copy of
      // that mistake. Two symptoms, reported together: National never appeared
      // on any row — every National code is filed under Enterprise — and some
      // rows were *blank*, which was this half-fix's own fault. Correcting the
      // filter above let those eight companies into the list while this line
      // still asked the old question, so they matched and then had nothing to
      // show for it.
      //
      // Rendered as labels rather than raw ids, so a row reads
      // "Avis · National" instead of "avis · national". The ids are internal
      // and this is the picker.
      const reachable = [
        ...new Set(company.codes.flatMap((c) => vendors.filter((vendor) => raceableAt(c, vendor)))),
      ].map((id) => findVendor(id)?.label ?? id);
      // A stranded row must say why rather than render the blank the fix above
      // is named after — and the reason has to be *determined*, not assumed.
      // "All refused" was asserted for every stranded row, so unticking the one
      // vendor a company has a code at labelled it `all refused` with an empty
      // refusal store. The two cases want opposite actions from the user: put
      // the refusals back, or pick a different vendor.
      const refusedHere = company.codes.some(
        (c) =>
          !!c.code &&
          vendors.some((v) => codeReaches(c.vendor, v) && refused.has(rejectionKey(v, c.code!))),
      );
      vendorList.textContent = reachable.length
        ? reachable.join(' · ')
        : refusedHere
          ? 'all refused'
          : 'no code at these vendors';

      row.append(box, name, vendorList);
      return row;
    }),
  );

  if (matches.length > shown.length) {
    const more = document.createElement('p');
    more.className = 'empty';
    more.textContent = `+${matches.length - shown.length} more — keep typing to narrow.`;
    companyList.append(more);
  }
}

function plannedCandidates(): { all: Candidate[]; capped: Candidate[]; skipped: number } {
  // Clamped both ends. The `max` attribute is a hint the browser enforces only
  // on submit, and `.value` still reports whatever was typed — so without this
  // a hand-edited 5000 would race every candidate there is.
  const max = Math.min(MAX_CODES, Math.max(1, Number(maxCodesInput.value) || 1));
  // Interleaved before the cap, so the codes we actually race are spread across
  // the selected vendors instead of being one vendor's alphabetical prefix.
  const refused = rejectionSet(ui.rejected);
  const proposed = buildCandidates({
    vendors: [...ui.vendors],
    companySlugs: [...ui.companies],
  });
  // Dropped before the interleave and the cap, so a refused code does not take
  // a slot from one that could be priced. Racing it can only ever fail, and it
  // costs a real tab on a real vendor site to find that out again.
  const usable = proposed.filter((c) => !refused.has(rejectionKey(c.vendor, c.code)));
  const all = interleaveByVendor(usable);
  return { all, capped: all.slice(0, max), skipped: proposed.length - usable.length };
}

/** "Hertz 4 · Avis 4 · Budget 4" — what the cap actually chose. */
function vendorBreakdown(candidates: Candidate[]): string {
  const counts = new Map<VendorId, number>();
  for (const candidate of candidates) {
    counts.set(candidate.vendor, (counts.get(candidate.vendor) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      ([aVendor, aCount], [bVendor, bCount]) => bCount - aCount || aVendor.localeCompare(bVendor),
    )
    .map(([vendor, count]) => `${findVendor(vendor)?.label ?? vendor} ${count}`)
    .join(' · ');
}

function refreshPlan(): void {
  // Before anything else: this is the state the popup cannot get itself out of,
  // so nothing below should be allowed to describe a plan the user cannot run.
  if (ui.sendFailed) {
    planSummary.textContent = SEND_FAILED_MESSAGE;
    planSummary.classList.add('is-warning');
    runBtn.disabled = true;
    // Except the note, which is about a different thing entirely and is the
    // second early return to have stranded it — the first was the all-refused
    // branch below. `sendFailed` is set by a failed GET_STATE at boot and is
    // cleared only by `renderRun`, which the clear path never calls, so a clear
    // that *worked* left this line still reading "N codes have been refused"
    // with the chips beside it already showing the restored counts. It is also
    // the state where a clear is most likely to have failed, and where
    // `CLEAR_FAILED_MESSAGE` could therefore never appear.
    renderRejectedNote();
    return;
  }
  const { all, capped, skipped } = plannedCandidates();
  const scope = ui.companies.size ? `${ui.companies.size} selected companies` : 'every company';
  // Named rather than silent. A code that vanishes from the plan with no
  // explanation is indistinguishable from one the database never had, and this
  // list is a cache of somebody else's answer — the user has to be able to see
  // it and undo it.
  const refusedNote = skipped
    ? ` ${skipped} refused ${skipped === 1 ? 'code is' : 'codes are'} being skipped.`
    : '';
  if (all.length === 0) {
    planSummary.textContent = skipped
      ? `No codes left to race — all ${skipped} were refused by the vendor.`
      : 'No codes match this selection.';
    planSummary.classList.add('is-warning');
    runBtn.disabled = true;
    // Before the early return, not after it. `renderRejectedNote` used to live
    // only on the success path below, so "try them again" was hidden in exactly
    // the state that needs it — every candidate refused, nothing to race, and
    // the one recovery control suppressed.
    renderRejectedNote();
    return;
  }
  // Not unconditionally: refreshPlan fires on every vendor chip, company
  // checkbox and max-codes keystroke, all reachable mid-run, and re-arming the
  // button let a second submit silently cancel the race in flight and discard
  // the quotes it had already collected.
  runBtn.disabled = ui.running || ui.pendingStart;
  const truncated = all.length > capped.length;
  // Always name the spread: a cap that silently picked one vendor is the whole
  // bug this replaced, and the only way to see it is to say what was chosen.
  planSummary.textContent =
    (truncated
      ? `${all.length} codes match ${scope} — racing ${capped.length} of them (${vendorBreakdown(capped)}). Narrow the list or raise the cap to try more.`
      : `Racing ${capped.length} code${capped.length === 1 ? '' : 's'} across ${scope} (${vendorBreakdown(capped)}).`) +
    refusedNote;
  planSummary.classList.toggle('is-warning', truncated);
  renderRejectedNote();
}

/**
 * Which refusal read is authoritative.
 *
 * Three places read that list — boot, the finished-run broadcast, and the clear
 * — and none of them was ordered against the others, so whichever `storage.get`
 * resolved *last* won regardless of which was issued last. The damage is not
 * symmetric: a run finishing as the user presses "try them again" could leave
 * the popup holding the pre-clear list, so the codes they had just cleared went
 * on being skipped and the note reappeared seconds later, with nothing to
 * correct it until the popup was reopened.
 *
 * A counter rather than three separate guards, because the ad-hoc one `main`
 * carried (`if (ui.rejected.length === 0)`) was the same idea written once for
 * the one pair of readers that had already collided.
 */
let rejectedRead = 0;

/**
 * Re-read the refusal list, unless a later read has been issued meanwhile.
 *
 * Returns what was stored, or null if this read was superseded — in which case
 * the caller must not act on it either, since it is describing a state the
 * popup has already moved past.
 */
async function reloadRejected(): Promise<RejectedCode[] | null> {
  const mine = ++rejectedRead;
  const entries = await loadRejected(chrome.storage.local);
  if (mine !== rejectedRead) return null;
  ui.rejected = entries;
  // The complaint is about the list as it was when the clear was pressed, so a
  // fresh reading of that list retires it. Without this the flag had no reset
  // but a *successful* clear, and "none needed — a clear that works empties the
  // list" was only true while nothing could refill it: the worker's bounded
  // wait can give up on a slow write, setting the flag, and then the queued
  // clear lands anyway — after which a later run refusing some entirely
  // different code redrew the note saying those codes "have not been cleared
  // yet", about a store that had been cleared and a refusal that postdates it.
  // The clear handler sets it again straight after this, from what it reads.
  ui.clearFailed = false;
  return entries;
}

/**
 * Where a failed clear says so.
 *
 * Created lazily rather than living in `index.html`, because it is absent in
 * every ordinary session and `el()` would make it a hard startup requirement.
 */
let clearFailedNote: HTMLElement | null = null;

/** The standing list, separate from this plan's skip count. */
function renderRejectedNote(): void {
  // Deduped, like every other consumer of this list. `loadRejected` accepts
  // whatever an older build wrote and does not collapse duplicates — which is
  // the stated premise for the two-directional `changed` comparison in the
  // RUN_STATE listener — so a stored `[A, A]` had this line saying "2 codes
  // have been refused" while the chips, the company list and the plan line all
  // accounted for one.
  const total = rejectionSet(ui.rejected).size;
  rejectedNote.hidden = total === 0;
  rejectedCount.textContent = total
    ? `${total} ${total === 1 ? 'code has' : 'codes have'} been refused by a vendor and are no longer raced — `
    : '';

  // Beside the button it is about, rather than in the plan line.
  //
  // It lived in `planSummary` for one round and that was wrong twice over:
  // `refreshPlan` writes that line wholesale, so the message *replaced* the
  // truncation warning ("40 codes match — racing 12 of them") and the
  // skipped-codes note for as long as the flag was set, and clearing the flag
  // from `renderRun` — which does not redraw the line — left the two
  // disagreeing in both directions. Here it obscures nothing, so neither
  // problem exists to be traded off, and it needs no reset: when a clear does
  // work `ui.rejected` empties, this whole note hides, and the message goes
  // with it.
  if (total > 0 && ui.clearFailed) {
    if (!clearFailedNote) {
      clearFailedNote = document.createElement('span');
      clearFailedNote.className = 'is-warning';
      rejectedNote.append(clearFailedNote);
    }
    clearFailedNote.textContent = ` ${CLEAR_FAILED_MESSAGE}`;
  } else if (clearFailedNote) {
    clearFailedNote.remove();
    clearFailedNote = null;
  }
}

function readTrip(): Trip {
  const data = new FormData(form);
  // The form has no file inputs, so anything non-string is not ours to read.
  const value = (name: string): string => {
    const entry = data.get(name);
    return typeof entry === 'string' ? entry.trim() : '';
  };

  if (ui.category === 'car') {
    return {
      category: 'car',
      pickupLocation: value('pickupLocation'),
      dropoffLocation: value('dropoffLocation'),
      pickupDate: value('pickupDate'),
      pickupTime: value('pickupTime') || '10:00',
      dropoffDate: value('dropoffDate'),
      dropoffTime: value('dropoffTime') || '10:00',
    };
  }
  return {
    category: 'hotel',
    destination: value('destination'),
    checkIn: value('checkIn'),
    checkOut: value('checkOut'),
    adults: Number(value('adults')) || 2,
    rooms: Number(value('rooms')) || 1,
  };
}

/** Both verified builders address a branch by IATA code, not by free text. */
const AIRPORT_CODE_RE = /^[A-Za-z]{3}$/;
/**
 * The *shape* both verified builders require, and all `<input type=time>` emits
 * today — but only because the fields carry no `step` attribute. With one,
 * Chrome emits `HH:MM:SS`, which `clock12` correctly rejects and which would
 * therefore fail Avis and Hertz at `link-build` while leaving the race to a
 * vendor that reaches no search. Checked here so that adding `step` is a
 * validation change rather than a silent loss of both working vendors.
 *
 * Deliberately weaker than `clock12`, which also rejects hour > 23 and
 * minute > 59: `25:99` passes here and throws `link-build` in the builders. A
 * `<input type=time>` cannot emit it, and duplicating the range checks in a
 * second place is how the two drift apart — so this checks shape only, and says
 * so rather than claiming to be equivalent.
 */
const CLOCK_RE = /^\d{1,2}:\d{2}$/;

/** Local date as yyyy-mm-dd. `toISOString` is UTC and shifts the day either
 *  side of midnight, which would send a date the user did not pick. */
function isoDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A throwaway trip whose only job is to make Avis render the page that carries
 * its bot check.
 *
 * Deliberately not the user's trip. This button is a session chore rather than
 * a search, and tying it to the form would make it fail whenever the form is
 * empty or half-filled — which is exactly when someone reaches for it. Dates
 * are computed from today rather than fixed, so it cannot quietly start asking
 * for a date in the past.
 *
 * Two months out and one day long: far enough ahead that availability is not
 * the thing being tested, short enough to be an obviously unreal booking.
 */
const BOT_CHECK_DAYS_AHEAD = 60;

function botCheckTrip(): Trip {
  const start = new Date();
  start.setDate(start.getDate() + BOT_CHECK_DAYS_AHEAD);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const typed = readTrip();
  const pickup =
    typed.category === 'car' && AIRPORT_CODE_RE.test(typed.pickupLocation.trim())
      ? typed.pickupLocation.trim().toUpperCase()
      : 'TPA';
  return {
    category: 'car',
    pickupLocation: pickup,
    dropoffLocation: '',
    pickupDate: isoDay(start),
    pickupTime: '12:00',
    dropoffDate: isoDay(end),
    dropoffTime: '12:00',
  };
}

function validate(trip: Trip): string | null {
  if (trip.category === 'car') {
    if (!trip.pickupLocation) return 'Enter a pick-up location.';
    // Checked here as well as in the builders, because failing per-vendor is
    // not a safe default: "Chicago Downtown" makes Avis and Hertz throw
    // `link-build` and hands the race to whatever is left.
    //
    // Who that is has changed twice, which is the point. It was Budget,
    // Enterprise and National, whose home pages answered with a marketing
    // "from $19/day"; then Sixt alone, whose builder took the location as free
    // text and was never verified either way. Both are `searchable: false` now,
    // and today's survivor is National — whose driver types the location into a
    // real form and refuses the quote unless the form shows the branch back.
    // So the current lineup happens to be safe.
    //
    // The check stays because that is a fact about today's vendors rather than
    // about the rule. Rejecting before any tab opens is the difference between
    // no answer and a confidently wrong one, whoever is racing.
    if (!AIRPORT_CODE_RE.test(trip.pickupLocation.trim())) {
      return 'Pick-up must be a 3-letter airport code, e.g. TPA.';
    }
    if (trip.dropoffLocation.trim() && !AIRPORT_CODE_RE.test(trip.dropoffLocation.trim())) {
      return 'Drop-off must be a 3-letter airport code, e.g. TPA.';
    }
    if (
      trip.dropoffLocation.trim() &&
      trip.dropoffLocation.trim().toUpperCase() !== trip.pickupLocation.trim().toUpperCase()
    ) {
      return 'One-way rentals are not supported yet — leave drop-off blank.';
    }
    if (!trip.pickupDate || !trip.dropoffDate) return 'Enter both rental dates.';
    if (!CLOCK_RE.test(trip.pickupTime) || !CLOCK_RE.test(trip.dropoffTime)) {
      return 'Times must be hh:mm.';
    }
    if (trip.dropoffDate < trip.pickupDate) return 'Drop-off is before pick-up.';
    return null;
  }
  if (!trip.destination) return 'Enter a destination.';
  if (!trip.checkIn || !trip.checkOut) return 'Enter both hotel dates.';
  if (trip.checkOut <= trip.checkIn) return 'Check-out must be after check-in.';
  return null;
}

/** How this category words a rate that isn't a total. */
function perUnitLabel(category: Category): string {
  return category === 'hotel' ? ' /night' : ' /day';
}

/** Plain-English name for one comparison bucket, e.g. "nightly rates in EUR". */
function basisPhrase(basis: PriceBasis, currency: string, category: Category): string {
  const kind =
    basis === 'total'
      ? 'trip totals'
      : basis === 'per-day'
        ? category === 'hotel'
          ? 'nightly rates'
          : 'daily rates'
        : 'prices of no stated kind';
  return `${kind} in ${currency}`;
}

/**
 * One short phrase per failure. Deliberately a lookup rather than free text:
 * the popup used to print whatever sentence the background happened to set,
 * which meant nothing could be counted or grouped, and a reworded string
 * silently changed what the user was told.
 */
const FAILURE_TEXT: Record<QuoteFailure, string> = {
  'link-build': 'could not build a search link',
  'tab-open': 'could not open a tab',
  'probe-timeout': 'no answer before the deadline',
  'probe-empty': 'page loaded, no price appeared',
  'extract-threw': 'could not read this page',
  'form-fill': 'could not fill the search form',
  // Not "never returned results", which reads as a synonym for probe-empty.
  // The distinction is that the search was never run, not that it found nothing.
  'form-submit': 'submitting the search never loaded a results page',
  // The vendor's own verdict on the code, not a fault in the run — so it says
  // what happened to the code rather than what failed to happen to the page.
  'code-rejected': 'the vendor refused this code',
  // Not "refused": nothing refused it. The search ran and the discount was not
  // on the answer, which is a different thing and a less certain one.
  'discount-missing': 'searched, but no company discount was applied',
  'wrong-trip': 'the page priced a different trip',
  'tab-closed': 'tab closed early',
  interrupted: 'interrupted mid-run',
  cancelled: 'cancelled',
};

/**
 * Short phrase for a known failure code, or nothing.
 *
 * Returning null rather than defaulting matters: a quote persisted by an older
 * build has a message but no code, and defaulting would have relabelled "tab
 * closed before pricing" as "no answer before the deadline". Inventing a
 * diagnosis is worse than admitting there isn't one.
 */
function describeFailure(quote: Quote): string | null {
  const failure = quote.failure;
  // Object.hasOwn, not `in` — `in` walks the prototype chain, so a stored value
  // of "toString" would have rendered a function body into the row.
  return failure && Object.hasOwn(FAILURE_TEXT, failure) ? FAILURE_TEXT[failure] : null;
}

/**
 * How long the vendor took, whether or not it said anything.
 *
 * Kept out of evidenceLine because it used to live inside it: a quote with no
 * report rendered no line at all, so `probe-timeout` — the one failure where
 * the elapsed time is the whole story — showed neither. The timing is
 * collected for every quote; only the rendering was conditional.
 *
 * Clamped and fixed-width: a clock that steps backwards mid-run would
 * otherwise render "-0.1s", and mixing "5s" with "5.3s" reads as two units.
 */
function durationText(quote: Quote): string {
  if (!quote.startedAt || !quote.finishedAt) return '';
  return `${Math.max(0, (quote.finishedAt - quote.startedAt) / 1000).toFixed(1)}s`;
}

function branchText(path: ProbeReport['path']): string {
  if (path === 'generic-sweep') return 'generic sweep';
  if (path === 'vendor-selectors') return 'vendor selectors';
  // Deliberately two possibilities, not one. All the background knows is that
  // it had no permission to read the tab's URL, which is equally true of a
  // redirect off the vendor's site and of a load that never committed — an
  // `about:blank` that hung, or a `chrome-error://` page after a DNS or TLS
  // failure. Naming only the first would be the same mistake as the "never
  // navigated" it replaced, pointing the opposite way.
  if (path === 'left-our-origins') return 'off the vendor’s site, or never got there';
  // The probe never answered, so the background described the tab instead.
  return 'no answer from the page';
}

/** "landed /en/home · 0 offers · generic sweep · 4.2s" — what the probe saw. */
function evidenceLine(quote: Quote): HTMLElement | null {
  const report = quote.report;
  const took = durationText(quote);
  // A duration with no report is still worth showing — that is exactly the
  // timeout case, where "45.0s" is the finding. Only for a quote that actually
  // ran out of time, though: "gave up after 3.2s" on a row the user cancelled
  // is both wrong and rude.
  if (!report) {
    if (!took || quote.failure !== 'probe-timeout') return null;
    const bare = document.createElement('p');
    bare.className = 'evidence';
    bare.textContent = `gave up after ${took}`;
    return bare;
  }
  const line = document.createElement('p');
  line.className = 'evidence';
  const plural = report.offerCount === 1 ? '' : 's';
  const observed = report.path === 'not-reached' || report.path === 'left-our-origins';
  const landed = report.finalPath
    ? `landed ${report.finalPath}`
    : report.path === 'left-our-origins'
      ? 'no permission to read this tab’s address'
      : 'no path to show';
  const counted = observed ? '' : ` · ${report.offerCount} offer${plural}`;
  line.textContent = `${landed}${counted} · ${branchText(report.path)}${took ? ` · ${took}` : ''}`;
  if (report.title) line.title = report.title;
  return line;
}

/**
 * "the page answered after the deadline" — evidence that arrived too late.
 *
 * Its own line rather than folded into the one above, because it contradicts
 * the failure text sitting beside it: the row says nothing came back, and this
 * says something did. That contradiction is the diagnosis.
 */
function lateAnswerLine(quote: Quote): HTMLElement | null {
  const report = quote.lateReport;
  if (!report) return null;
  const line = document.createElement('p');
  line.className = 'evidence is-late';
  const plural = report.offerCount === 1 ? '' : 's';
  line.textContent = `the page did answer, just after the deadline — ${report.finalPath} · ${report.offerCount} offer${plural} · ${branchText(report.path)}`;
  if (report.title) line.title = report.title;
  return line;
}

function renderQuote(quote: Quote, winnerId: string | null, trip: Trip): HTMLLIElement {
  const item = document.createElement('li');
  item.className = quote.id === winnerId ? 'quote is-winner' : 'quote';

  const who = document.createElement('span');
  who.className = 'who';
  const name = document.createElement('span');
  name.className = 'company-name';
  name.textContent = quote.candidate.companyName;
  name.title = quote.candidate.companyName;
  const code = document.createElement('span');
  code.className = 'code';
  // The vendor's own label and codeLabel, not the raw internal id. Both have been
  // populated for every vendor since the first commit and read by nothing, so
  // the row said "national · XZ42PWC" where the vendor's own site says
  // "National Contract ID XZ42PWC".
  // Soft lookup: this renders a snapshot from chrome.storage.session, and
  // getVendor throws — one unrecognised id would empty the whole list instead
  // of degrading one row to the raw id.
  const vendor = findVendor(quote.candidate.vendor);
  const vendorLabel = vendor ? `${vendor.label} ${vendor.codeLabel}` : quote.candidate.vendor;
  code.textContent = `${vendorLabel} · ${quote.candidate.code}`;
  who.append(name, code);

  const right = document.createElement('span');
  if (quote.best) {
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = money(quote.best.amount, quote.best.currency);
    right.append(price);
    if (quote.best.basis !== 'total') {
      const basis = document.createElement('span');
      basis.className = 'basis';
      basis.textContent =
        quote.best.basis === 'per-day' ? perUnitLabel(trip.category) : ' (basis unclear)';
      right.append(basis);

      // A daily rate is not comparable to a total, so it never enters the
      // ranking — but showing the trip-length arithmetic saves doing it in your
      // head. Labelled an estimate because that is exactly what it is.
      const estimate = estimatedTotal(quote.best, trip);
      if (estimate !== null) {
        const projected = document.createElement('span');
        projected.className = 'estimate';
        projected.textContent = ` ≈ ${money(estimate, quote.best.currency)} est.`;
        projected.title =
          'Daily rate × trip length. Excludes taxes and fees, and is not used for ranking.';
        right.append(projected);
      }
    }
  } else {
    const status = document.createElement('span');
    status.className = quote.status === 'error' ? 'status is-error' : 'status';
    status.textContent =
      quote.status === 'loading'
        ? 'checking…'
        : quote.status === 'pending'
          ? 'queued'
          : (describeFailure(quote) ?? quote.message ?? quote.status);
    if (quote.message) status.title = quote.message;
    right.append(status);
  }

  item.append(who, right);

  // Evidence where it is load-bearing: any failure, plus the flagged case.
  // Gating on a failed status alone hid it from the quote that needs it most —
  // one flagged as landing on the home page still reads `ok`, so the user got
  // the accusation with nothing to check it against. Showing it on every row
  // instead was the over-correction: 25 codes would mean 25 lines nobody reads.
  if (quote.status !== 'ok' || quote.suspect) {
    const evidence = evidenceLine(quote);
    if (evidence) item.append(evidence);
    const late = lateAnswerLine(quote);
    if (late) item.append(late);
  }

  // The failure that does not look like one: a deep link that missed its search
  // still shows a plausible "from $19/day", so the quote reads ok and simply
  // wins. Say so where the price is, not in a console nobody opens.
  if (quote.suspect === 'landed-elsewhere') {
    const warning = document.createElement('p');
    warning.className = 'hint is-warning';
    warning.textContent =
      'This landed on the vendor home page, not a results page — the code was almost certainly not applied.';
    item.append(warning);
  }

  if (quote.url) {
    const link = document.createElement('a');
    link.href = quote.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'open';
    item.append(link);
  }

  return item;
}

function renderRun(state: RunState | null): void {
  const running = Boolean(state && !state.finishedAt);
  ui.running = running;
  // The background has answered, so the click is no longer in flight and
  // `running` is authoritative from here. That also clears the unreachable
  // state: an answer is proof it is reachable, and GET_STATE on a reopened
  // popup is exactly how the user recovers.
  ui.pendingStart = false;
  ui.sendFailed = false;
  cancelBtn.hidden = !running;
  runBtn.disabled = running;
  runBtn.textContent = running ? 'Racing codes…' : 'Find the cheapest code';

  if (!state) {
    results.hidden = true;
    return;
  }
  results.hidden = false;

  const trip = state.plan.trip;
  const ranked = orderForDisplay(state.quotes);
  const winner = cheapestComparable(state.quotes);
  quotesList.replaceChildren(
    ...ranked.map((quote) => renderQuote(quote, winner?.id ?? null, trip)),
  );

  // One line for the list rather than a badge per row, which stays workable
  // only while the verified vendors are few enough to name.
  //
  // This deliberately renders even when nothing is unverified. It used to be
  // `if (unverified > 0)`, so the moment Avis and Hertz became `verified` a run
  // containing only those two — which is most of the car codes, and the obvious
  // selection once the others are known to be unusable — printed no caveat at
  // all. `verified` is a claim about the URL shape, proved on one US round-trip
  // from an airport; it is not a claim that the price is right for any
  // itinerary, and silence reads as the stronger promise.
  // `link-build` quotes are excluded: the worker stamps them `best-effort` on
  // the catch path, so counting them said "N of these search links are
  // unverified" about links that were never built, let alone followed.
  // Driven vendors are excluded from *both* counts, not just from `unverified`.
  // They have no search link to grade — the code and the itinerary are typed
  // into the vendor's own form — so counting them among the links made the
  // sentence claim something untrue in whichever branch it landed in: a
  // National-only run read "these search links are checked against the live
  // site" about a link that carries no search at all.
  const linked = state.quotes.filter(
    (q) => q.failure !== 'link-build' && q.confidence !== 'driven',
  );
  const unverified = linked.filter((q) => q.confidence === 'best-effort').length;
  const driven = state.quotes.filter(
    (q) => q.confidence === 'driven' && q.failure !== 'link-build',
  ).length;
  const note = document.createElement('li');
  note.className = 'hint';
  const drivenNote = driven
    ? `${driven} ${driven === 1 ? 'code was' : 'codes were'} searched by filling the vendor's own ` +
      'form, and dropped unless its results named the account. '
    : '';
  if (linked.length === 0 && driven === 0) {
    note.textContent = 'None of these codes could be turned into a search — nothing was looked up.';
  } else if (linked.length === 0) {
    note.textContent = `${drivenNote}Confirm the rate before booking.`;
  } else if (unverified === linked.length) {
    note.textContent = `${drivenNote}Vendor search links are reverse-engineered and unverified — a result that looks wrong probably is.`;
  } else if (unverified > 0) {
    note.textContent =
      `${drivenNote}${unverified} of these search links ${unverified === 1 ? 'is' : 'are'} ` +
      'reverse-engineered and unverified — a result that looks wrong probably is. The rest are ' +
      'checked against the live site for US airport round-trips only, and assume a driver aged 25 ' +
      'or over.';
  } else {
    note.textContent =
      `${drivenNote}These search links are checked against the live site for US airport ` +
      'round-trips only, and assume a driver aged 25 or over. Confirm the rate before booking.';
  }
  quotesList.append(note);

  const spread = savings(state.quotes);
  // Split by *why* they are unranked. The sentence below can only talk about
  // basis and currency, and a quote that landed on the vendor's home page is
  // normally in the same basis and currency as the winner — so lumping the two
  // together printed "quoted daily rates in USD" as the reason a quote was set
  // aside from a bucket that *is* daily rates in USD. That is asserting a
  // diagnosis known to be the wrong one, which the row-level warning three
  // hundred lines up already contradicts.
  const unranked = unrankedQuotes(state.quotes);
  const setAside = unranked.filter((q) => !q.suspect);
  const landedElsewhere = unranked.filter((q) => q.suspect);
  savingsBox.hidden = !spread && setAside.length === 0 && landedElsewhere.length === 0;
  savingsBox.replaceChildren();

  if (spread && winner) {
    // Built node by node rather than as a template string: company names come
    // from the workbook and prices ultimately from a vendor page, and neither
    // should ever be parsed as markup.
    const strong = (text: string): HTMLElement => {
      const node = document.createElement('strong');
      node.textContent = text;
      return node;
    };
    const line = document.createElement('div');
    line.append(
      'Cheapest is ',
      strong(winner.candidate.companyName),
      ` (${winner.candidate.code}) at `,
      strong(money(spread.best, spread.currency)),
      ` — ${money(spread.absolute, spread.currency)} (${spread.percent.toFixed(0)}%) under the priciest comparable code, counting ${basisPhrase(spread.basis, spread.currency, trip.category)}.`,
    );
    savingsBox.append(line);

    const thing = trip.category === 'hotel' ? 'room type' : 'vehicle';

    // Flag the case where the winner is only cheap because it surfaced a
    // different class of car than the others did. Restricted to the bucket the
    // ranking came from: a matrix built from a daily rate on one side and a
    // trip total on the other cannot say anything about fairness.
    //
    // Built from the ranked quotes, not from every quote. bestOffer picks a
    // quote's headline basis and currency by majority, so a quote whose offers
    // are mostly in euros sits outside the reported bucket and is listed as
    // not ranked — while its stray dollar offers still entered this matrix and
    // could hold the cheapest row. The popup then warned that "another code is
    // cheaper on the classes these results have in common", naming a code it
    // had just told the user was not comparable.
    const ranked = primaryGroup(state.quotes)?.quotes ?? [];
    const shared = classMatrix(ranked, {
      basis: spread.basis,
      currency: spread.currency,
    }).filter((row) => row.amounts.size > 1);
    const winnerWinsShared = shared.some((row) => row.bestQuoteId === winner.id);

    if (shared.length === 0) {
      // No overlap at all is the weakest evidence there is, and it used to pass
      // in silence — the winner looked as clean as one that beat every rival on
      // matched classes.
      const caveat = document.createElement('p');
      caveat.className = 'hint is-warning';
      caveat.textContent = `Heads up: these codes surfaced no ${thing} in common, so there is nothing to check the winner against — the prices may not describe the same thing.`;
      savingsBox.append(caveat);
    } else if (!winnerWinsShared) {
      const caveat = document.createElement('p');
      caveat.className = 'hint is-warning';
      caveat.textContent = `Heads up: another code is cheaper on the classes these results have in common, so this winner may just be showing a different ${thing}.`;
      savingsBox.append(caveat);
    }
  }

  // Outside the spread block on purpose. One total against one daily rate
  // produces no spread at all, and that is precisely when the odd one out most
  // needs explaining — otherwise it sits in the list looking like it lost.
  if (setAside.length > 0) {
    const kinds = [
      ...new Set(setAside.map((q) => basisPhrase(q.best.basis, q.best.currency, trip.category))),
    ];
    const note = document.createElement('p');
    note.className = 'hint';
    const plural = setAside.length === 1 ? '' : 's';
    note.textContent = spread
      ? `${setAside.length} other code${plural} quoted ${kinds.join(' or ')}. Listed below, but not ranked — that is a different question from the one above.`
      : `${setAside.length} code${plural} quoted ${kinds.join(' or ')}, which cannot be compared with the rest. Nothing here is ranked against it.`;
    savingsBox.append(note);
  }

  if (landedElsewhere.length > 0) {
    const note = document.createElement('p');
    note.className = 'hint';
    const plural = landedElsewhere.length === 1 ? '' : 's';
    const verb = landedElsewhere.length === 1 ? 'its' : 'their';
    note.textContent =
      `${landedElsewhere.length} code${plural} landed on the vendor's home page rather than ` +
      `${verb} search, so the price found there is not for this trip. Listed below, but not ranked.`;
    savingsBox.append(note);
  }
}

async function saveForm(): Promise<void> {
  const data = new FormData(form);
  const fields: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  await chrome.storage.local.set({
    [FORM_STATE_KEY]: {
      category: ui.category,
      vendors: [...ui.vendors],
      companies: [...ui.companies],
      maxCodes: maxCodesInput.value,
      concurrency: concurrencyInput.value,
      fields,
    },
  });
}

interface SavedForm {
  category?: Category;
  vendors?: VendorId[];
  companies?: string[];
  maxCodes?: string;
  concurrency?: string;
  fields?: Record<string, string>;
}

async function restoreForm(): Promise<void> {
  const stored = await chrome.storage.local.get(FORM_STATE_KEY);
  const saved = stored[FORM_STATE_KEY] as SavedForm | undefined;
  if (!saved) return;

  // Everything here came out of chrome.storage and is only as trustworthy as
  // the version of the extension that wrote it. An unknown vendor id reaches
  // getVendor(), which throws — killing main() and leaving a half-rendered
  // popup stuck on "Loading codes…" with no way to recover. A company slug
  // that no longer exists after `npm run codes` is quieter but just as stuck:
  // nothing matches, Run is disabled, and no checkbox exists to untick.
  if (saved.category === 'car' || saved.category === 'hotel') ui.category = saved.category;
  if (saved.vendors?.length) {
    // Filtered against the *searchable* vendors, not all of VENDORS. A vendor
    // that stops being searchable — as Budget, Enterprise and National just
    // did — otherwise survives in storage forever and is re-persisted on the
    // next save, because nothing else ever removes it: the chips are gone, so
    // there is no checkbox to untick.
    //
    // It is not harmless while it sits there. `buildCandidates` drops it, so
    // the plan stays honest, but `renderCompanyList` filters on the raw set —
    // an upgrading user saw 37 company rows instead of 25, labelled with
    // vendors that have no chip, and ticking an Enterprise-only company gave
    // "No codes match this selection." with nothing on screen explaining why.
    // That is the same promise-what-cannot-run defect the unsearchable change
    // removed, arriving through storage instead.
    const known = new Set<string>(searchableVendors().map((vendor) => vendor.id));
    ui.vendors = new Set(saved.vendors.filter((id) => known.has(id)));
  }
  if (saved.companies?.length) {
    const known = new Set(allCompanies().map((company) => company.slug));
    ui.companies = new Set(saved.companies.filter((slug) => known.has(slug)));
  }
  if (saved.maxCodes) maxCodesInput.value = saved.maxCodes;
  if (saved.concurrency) concurrencyInput.value = saved.concurrency;

  for (const [key, value] of Object.entries(saved.fields ?? {})) {
    const input = form.elements.namedItem(key);
    if (input instanceof HTMLInputElement) input.value = value;
  }
}

function setCategory(category: Category): void {
  // Car vendors and hotel vendors share no codes, so switching category has to
  // drop the old selection — but re-applying the *current* category (which is
  // what happens on every popup open) must leave a restored selection alone.
  if (ui.category !== category) {
    ui.vendors.clear();
    ui.companies.clear();
  }
  ui.category = category;
  carFields.classList.toggle('is-hidden', category !== 'car');
  hotelFields.classList.toggle('is-hidden', category !== 'hotel');
  // Only the visible section should block submit on empty required fields.
  for (const input of carFields.querySelectorAll('input')) {
    input.disabled = category !== 'car';
  }
  for (const input of hotelFields.querySelectorAll('input')) {
    input.disabled = category !== 'hotel';
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.classList.toggle('is-active', tab.dataset['category'] === category);
  }
  defaultVendorsIfEmpty();
  renderVendorChips();
  renderCompanyList();
  refreshPlan();
}

/**
 * Talk to the background, retrying once — except for START_RUN.
 *
 * A rejection here is usually the service worker asleep or mid-restart, which
 * one retry fixes. It does not mean the message went undelivered, so a null
 * reply must not be read as "no run" — doing that cleared ui.running and
 * re-armed the button, letting the next click cancel a race still in flight.
 */
async function send(request: PopupRequest): Promise<StateMessage | null> {
  // START_RUN is the one request that is not idempotent: a rejection does not
  // prove non-delivery, and retrying it starts a second race that opens real
  // vendor tabs before cancelling the first. CLAUDE.md's politeness rule beats
  // the convenience of a retry here.
  const attempts = request.type === 'START_RUN' ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage<PopupRequest, StateMessage>(request);
    } catch {
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return null;
}

/** Render a reply, or say why there isn't one instead of going quiet. */
function applyReply(reply: StateMessage | null): void {
  if (reply) {
    renderRun(reply.state);
    return;
  }
  // Leave whatever is on screen alone — the run may well still be going. That
  // includes leaving Run disabled if a START_RUN turned it off: a rejection
  // does not prove non-delivery, so re-arming it would offer the user a second
  // race on top of one that may already be opening tabs. Reopening the popup
  // is the recovery, and it re-arms correctly from GET_STATE.
  ui.sendFailed = true;
  planSummary.textContent = SEND_FAILED_MESSAGE;
  planSummary.classList.add('is-warning');
  // The button says what to do, because the plan line is the first thing a
  // keystroke used to overwrite and the label is the thing being clicked.
  runBtn.textContent = 'Reopen the popup to retry';
  runBtn.disabled = true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const trip = readTrip();
  const problem = validate(trip);
  if (problem) {
    planSummary.textContent = problem;
    planSummary.classList.add('is-warning');
    return;
  }

  const { capped } = plannedCandidates();
  if (capped.length === 0) return;

  const plan: SearchPlan = {
    trip,
    candidates: capped,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrencyInput.value) || 2)),
  };

  void saveForm();
  // Disabled here, synchronously, not when the reply lands. `ui.running` is
  // only set by applyReply, so between the click and the background answering
  // — a window create and a storage write — the button stayed live and a
  // second press sent a second START_RUN. That opened a second minimised
  // window and doubled the tabs pointed at every vendor. A double-click was
  // enough. The background shares the run already starting rather than
  // building a new one; this is the half that stops the message being sent.
  ui.pendingStart = true;
  runBtn.disabled = true;
  void send({ type: 'START_RUN', plan }).then(applyReply);
});

avisCaptchaBtn.addEventListener('click', () => {
  // Opens one ordinary, focused tab and nothing else. It does not answer the
  // check, and deliberately cannot: passing it is the user's to do, and the
  // clearance it sets is what the probe tabs then ride on for the session.
  //
  // No discount code — `withParams` drops empty values, so this asks for a
  // plain availability page. The point is to reach the page that carries the
  // check, not to price anything.
  // Both halves can fail, and a button that does nothing silently is worse than
  // one that says why: `buildDeepLink` throws by design for a vendor that stops
  // being searchable, and `tabs.create` rejects if the window has gone.
  try {
    const { url } = buildDeepLink('avis', '', botCheckTrip());
    void chrome.tabs.create({ url, active: true }).catch(() => {
      planSummary.textContent = 'Could not open a tab for the Avis bot check.';
      planSummary.classList.add('is-warning');
    });
  } catch {
    planSummary.textContent = 'Could not build the Avis bot-check link.';
    planSummary.classList.add('is-warning');
  }
});

/**
 * Where to send someone to clear Budget's bot check.
 *
 * A plain constant rather than `buildDeepLink('budget', …)`, because that
 * builder throws by design — Budget keeps its search in session state and will
 * never have a URL. There is no driver to take a `startUrl` from yet either, so
 * two vendors with two shapes is not a registry.
 *
 * The difference from Avis matters and is not cosmetic. Avis carries its check
 * on the availability page, so its button lands on the check itself and the
 * chore is one click. Budget's appeared only on *submitting* a search — a fully
 * filled form, first submission from a clean page — so this lands on the form
 * and the user has to run a search to raise it. Capturing the URL the challenge
 * is served at would make this one-click too; nobody has recorded it.
 */
const BUDGET_BOT_CHECK_URL = 'https://www.budget.com/en/home';

budgetCaptchaBtn.addEventListener('click', () => {
  // Same contract as the Avis button above: one ordinary focused tab, and it
  // answers nothing. Passing the check is the user's to do.
  //
  // Unlike the Avis one, this is **preparatory rather than load-bearing**, and
  // saying so matters. Budget is `searchable: false`, has no host permission and
  // no content-script match, so no probe tab visits budget.com and there is no
  // later tab to ride the clearance. It exists so the open question — whether a
  // human pass survives an automated submit — can be answered at all, which is
  // what decides whether a Budget driver is worth writing.
  void chrome.tabs.create({ url: BUDGET_BOT_CHECK_URL, active: true }).catch(() => {
    // Visible, for the reason the Avis one is: the user's next move is to go and
    // do something in a tab, so a silent failure sends them to wait at a page
    // that never opened.
    planSummary.textContent = 'Could not open a tab for the Budget bot check.';
    planSummary.classList.add('is-warning');
  });
});

rejectedClear.addEventListener('click', () => {
  // Forgets every refusal rather than offering a per-code list. The whole point
  // is to re-ask the vendor, and the vendors are the authority — a picker over
  // remembered answers would be a UI for second-guessing a cache.
  //
  // Asked of the background rather than written here, because the popup and the
  // worker are separate realms: a clear written from this side can land between
  // an in-flight `recordRejected`'s read and its write, and be undone by it.
  // See CLEAR_REJECTED in `messages.ts`.
  //
  // Storage decides whether it worked, not the reply — on every path, which is
  // what makes the three ways this can go wrong come out right:
  //
  // - **A null reply does not prove the clear did not happen.** `send` retries
  //   and a rejection does not prove non-delivery; this file already reasons
  //   that way about START_RUN. Treating it as failure while the worker really
  //   had cleared would leave `ui.rejected` populated for the whole session,
  //   filtering out codes the store no longer refuses.
  // - **A reply does not prove it did.** The worker's wait on the write is
  //   bounded, so a slow `chrome.storage` gets a perfectly ordinary
  //   `RUN_STATE` back with the clear still queued.
  // - A run settling a refusal in the same moment should not be papered over
  //   either way.
  //
  // Judged against the refusals this popup *knew about*, so a new one recorded
  // in the meantime does not read as a failed clear.
  const before = rejectionSet(ui.rejected);
  void send({ type: 'CLEAR_REJECTED' })
    .then(() => reloadRejected())
    .then((entries) => {
      // Null means a later read is already authoritative — it has stored its own
      // answer, and judging the clear against a list this one never saw would
      // be worse than saying nothing.
      if (!entries) return;
      ui.clearFailed = entries.some((entry) => before.has(rejectionKey(entry.vendor, entry.code)));
      // Chips and the company list carry the count too, so `refreshPlan` alone
      // would leave them showing the reduced numbers after putting the codes back.
      renderVendorChips();
      renderCompanyList();
      refreshPlan();
    });
});

cancelBtn.addEventListener('click', () => {
  void send({ type: 'CANCEL_RUN' }).then(applyReply);
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    const category = tab.dataset['category'];
    if (category === 'car' || category === 'hotel') {
      setCategory(category);
      void saveForm();
    }
  });
}

companySearch.addEventListener('input', renderCompanyList);
maxCodesInput.addEventListener('input', refreshPlan);

chrome.runtime.onMessage.addListener((message: StateMessage) => {
  if (message.type !== 'RUN_STATE') return;
  renderRun(message.state);
  // A run that has just finished may have refused codes, and the popup often
  // stays open across one. Without this reload `ui.rejected` is whatever boot
  // saw, so pressing Run again immediately re-races codes the vendor refused a
  // moment ago — spending a real tab to rediscover a refusal, which is the one
  // thing remembering them exists to avoid.
  if (message.state?.finishedAt) {
    // Both directions, not `length` plus one-way containment. `loadRejected`
    // does not dedupe and accepts whatever an older build wrote, so a stored
    // `[A, A]` against a held `[A, B]` compares equal on both of those and
    // leaves B's codes excluded from the counts until the popup is reopened.
    const before = rejectionSet(ui.rejected);
    void reloadRejected().then((entries) => {
      // Superseded: a clear the user pressed in the meantime has already stored
      // its answer, and this read predates it. Applying it would put the codes
      // they just cleared back into the counts.
      if (!entries) return;
      const after = rejectionSet(entries);
      const changed = before.size !== after.size || [...after].some((key) => !before.has(key));
      // Before boot has established a selection there is nothing to preserve and
      // no selection to draw: `restoreForm` and `setCategory` have not run, so
      // `ui.vendors` is empty and rendering here would draw every chip unticked
      // under a user who has several picked, plus "Pick at least one vendor".
      // It self-corrects when `setCategory` renders a moment later, which makes
      // it a flicker rather than a stuck state — and one this listener could not
      // produce until the default-fill moved out of the render.
      if (!booted) return;
      // Only when a refusal was actually recorded. Both renders are a full
      // `replaceChildren`, and a run finishes asynchronously with whatever the
      // user is doing — rebuilding the company list under someone mid-click
      // resets their scroll and drops their focus. Most runs record nothing, so
      // this makes the disruption as rare as the news that causes it. It does
      // not remove it: a run that does refuse a code still rebuilds both lists,
      // which is the honest trade for showing counts that are no longer true.
      if (changed) {
        renderVendorChips();
        renderCompanyList();
      }
      refreshPlan();
    });
  }
});

async function main(): Promise<void> {
  // The HTML cannot import the constant, so it is written here instead of
  // trusted to stay in step. A `max` that disagrees with the worker's clamp
  // offers the user a concurrency the background silently refuses.
  concurrencyInput.max = String(MAX_CONCURRENCY);
  // Same reason, and the same failure if they drift: the attribute is what the
  // user is offered, `plannedCandidates` is what actually runs.
  maxCodesInput.max = String(MAX_CODES);

  // Before restoreForm, so the first refreshPlan already knows what to skip.
  //
  // Through `reloadRejected` like the other two readers, so a listener read
  // issued after this one wins even if it resolves first. This used to carry
  // its own `if (ui.rejected.length === 0)` guard, which was the same idea
  // written for one pair of readers rather than all three.
  await reloadRejected();
  await restoreForm();
  setCategory(ui.category);
  booted = true;

  const totalCodes = vendorsFor('car')
    .concat(vendorsFor('hotel'))
    .reduce((sum, vendor) => sum + countCodesFor(vendor.id), 0);
  tagline.textContent = `${totalCodes} corporate codes loaded. Pick a trip and let them fight.`;

  applyReply(await send({ type: 'GET_STATE' }));
}

// An unhandled rejection here leaves the popup half-rendered and silent — the
// tagline still reading "Loading codes…" with no clue why. Say what broke.
void main().catch((error: unknown) => {
  planSummary.textContent = `Could not start up: ${error instanceof Error ? error.message : String(error)}`;
  planSummary.classList.add('is-warning');
  runBtn.disabled = true;
});
