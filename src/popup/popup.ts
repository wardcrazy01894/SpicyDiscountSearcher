import {
  allCompanies,
  buildCandidates,
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
}

const ui: UiState = {
  category: 'car',
  vendors: new Set<VendorId>(),
  companies: new Set<string>(),
  running: false,
  pendingStart: false,
  sendFailed: false,
};

/** Kept in one place because refreshPlan and applyReply both write it. */
const SEND_FAILED_MESSAGE = 'Could not reach the extension background. Reopen the popup to retry.';

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

function renderVendorChips(): void {
  const vendors = vendorsFor(ui.category);
  // Whenever nothing is selected — not only on first open. Deliberate: an
  // empty selection cannot race anything, so it is treated as "no preference"
  // rather than "race nothing".
  if (ui.vendors.size === 0) for (const vendor of vendors) ui.vendors.add(vendor.id);

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
        refreshPlan();
        void saveForm();
      });

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(countCodesFor(vendor.id));

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

function renderCompanyList(): void {
  const query = companySearch.value;
  const vendors = [...ui.vendors];
  const matches = searchCompanies(query).filter((company) =>
    company.codes.some((code) => code.code && vendors.includes(code.vendor)),
  );
  const selected = selectionSummary();

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = query
      ? `No company matching "${query}" has a code for these vendors.`
      : 'Pick at least one vendor.';
    // Still offer the escape hatch — an empty list is exactly when a stale
    // selection has stranded the plan.
    companyList.replaceChildren(...(selected ? [selected, empty] : [empty]));
    return;
  }

  // Long lists make the popup crawl; the search box is how you reach the rest.
  const shown = matches.slice(0, 60);
  companyList.replaceChildren(
    ...(selected ? [selected] : []),
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
      vendorList.textContent = [
        ...new Set(
          company.codes.filter((c) => c.code && vendors.includes(c.vendor)).map((c) => c.vendor),
        ),
      ].join(' · ');

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

function plannedCandidates(): { all: Candidate[]; capped: Candidate[] } {
  const max = Math.max(1, Number(maxCodesInput.value) || 1);
  // Interleaved before the cap, so the codes we actually race are spread across
  // the selected vendors instead of being one vendor's alphabetical prefix.
  const all = interleaveByVendor(
    buildCandidates({
      vendors: [...ui.vendors],
      companySlugs: [...ui.companies],
    }),
  );
  return { all, capped: all.slice(0, max) };
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
    return;
  }
  const { all, capped } = plannedCandidates();
  const scope = ui.companies.size ? `${ui.companies.size} selected companies` : 'every company';
  if (all.length === 0) {
    planSummary.textContent = 'No codes match this selection.';
    planSummary.classList.add('is-warning');
    runBtn.disabled = true;
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
  planSummary.textContent = truncated
    ? `${all.length} codes match ${scope} — racing ${capped.length} of them (${vendorBreakdown(capped)}). Narrow the list or raise the cap to try more.`
    : `Racing ${capped.length} code${capped.length === 1 ? '' : 's'} across ${scope} (${vendorBreakdown(capped)}).`;
  planSummary.classList.toggle('is-warning', truncated);
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

function validate(trip: Trip): string | null {
  if (trip.category === 'car') {
    if (!trip.pickupLocation) return 'Enter a pick-up location.';
    // Checked here as well as in the builders, because failing per-vendor is
    // not a safe default. "Chicago Downtown" makes Avis and Hertz throw
    // `link-build` and leaves the race to be decided *only* by Budget,
    // Enterprise and National — the three whose links are known not to reach a
    // search at all, and whose home pages answer with a "from $19/day" that
    // wins. Rejecting before any tab opens is the difference between no answer
    // and a confidently wrong one.
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
  const unverified = state.quotes.filter(
    (q) => q.confidence === 'best-effort' && q.failure !== 'link-build',
  ).length;
  const buildable = state.quotes.filter((q) => q.failure !== 'link-build').length;
  const note = document.createElement('li');
  note.className = 'hint';
  if (buildable === 0) {
    note.textContent = 'None of these codes could be turned into a search — nothing was looked up.';
  } else if (unverified === buildable) {
    note.textContent =
      'Vendor search links are reverse-engineered and unverified — a result that looks wrong probably is.';
  } else if (unverified > 0) {
    note.textContent =
      `${unverified} of these search links ${unverified === 1 ? 'is' : 'are'} reverse-engineered ` +
      'and unverified — a result that looks wrong probably is. The rest are checked against the ' +
      'live site for US airport round-trips only, and assume a driver aged 25 or over.';
  } else {
    note.textContent =
      'These search links are checked against the live site for US airport round-trips only, and ' +
      'assume a driver aged 25 or over. Confirm the rate before booking.';
  }
  quotesList.append(note);

  const spread = savings(state.quotes);
  const setAside = unrankedQuotes(state.quotes);
  savingsBox.hidden = !spread && setAside.length === 0;
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
  if (message.type === 'RUN_STATE') renderRun(message.state);
});

async function main(): Promise<void> {
  // The HTML cannot import the constant, so it is written here instead of
  // trusted to stay in step. A `max` that disagrees with the worker's clamp
  // offers the user a concurrency the background silently refuses.
  concurrencyInput.max = String(MAX_CONCURRENCY);

  await restoreForm();
  setCategory(ui.category);

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
