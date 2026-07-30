import {
  allCompanies,
  buildCandidates,
  countCodesFor,
  interleaveByVendor,
  searchCompanies,
} from '../core/codes.js';
import {
  cheapest,
  classMatrix,
  estimatedTotal,
  rankQuotes,
  savings,
  unrankedQuotes,
} from '../core/compare.js';
import type { PopupRequest, StateMessage } from '../core/messages.js';
import type {
  Candidate,
  Category,
  PriceBasis,
  Quote,
  RunState,
  SearchPlan,
  Trip,
  VendorId,
} from '../core/types.js';
import { VENDORS, getVendor, vendorsFor } from '../core/vendors.js';

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
}

const ui: UiState = {
  category: 'car',
  vendors: new Set<VendorId>(),
  companies: new Set<string>(),
  running: false,
};

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
  // Default to every vendor in the category the first time it's shown.
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
    .map(([vendor, count]) => `${getVendor(vendor).label} ${count}`)
    .join(' · ');
}

function refreshPlan(): void {
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
  runBtn.disabled = ui.running;
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

function validate(trip: Trip): string | null {
  if (trip.category === 'car') {
    if (!trip.pickupLocation) return 'Enter a pick-up location.';
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
  code.textContent = `${quote.candidate.vendor} · ${quote.candidate.code}`;
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
          : (quote.message ?? quote.status);
    right.append(status);
  }

  item.append(who, right);

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
  cancelBtn.hidden = !running;
  runBtn.disabled = running;
  runBtn.textContent = running ? 'Racing codes…' : 'Find the cheapest code';

  if (!state) {
    results.hidden = true;
    return;
  }
  results.hidden = false;

  const trip = state.plan.trip;
  const ranked = rankQuotes(state.quotes);
  const winner = cheapest(state.quotes);
  quotesList.replaceChildren(
    ...ranked.map((quote) => renderQuote(quote, winner?.id ?? null, trip)),
  );

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
    const shared = classMatrix(state.quotes, {
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
    const known = new Set<string>(VENDORS.map((vendor) => vendor.id));
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

async function send(request: PopupRequest): Promise<StateMessage | null> {
  try {
    return await chrome.runtime.sendMessage<PopupRequest, StateMessage>(request);
  } catch {
    // The service worker can be asleep or mid-restart; the popup just shows
    // whatever it already had rather than throwing at the user.
    return null;
  }
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
    concurrency: Math.max(1, Math.min(6, Number(concurrencyInput.value) || 2)),
  };

  void saveForm();
  void send({ type: 'START_RUN', plan }).then((reply) => renderRun(reply?.state ?? null));
});

cancelBtn.addEventListener('click', () => {
  void send({ type: 'CANCEL_RUN' }).then((reply) => renderRun(reply?.state ?? null));
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
  await restoreForm();
  setCategory(ui.category);

  const totalCodes = vendorsFor('car')
    .concat(vendorsFor('hotel'))
    .reduce((sum, vendor) => sum + countCodesFor(vendor.id), 0);
  tagline.textContent = `${totalCodes} corporate codes loaded. Pick a trip and let them fight.`;

  const reply = await send({ type: 'GET_STATE' });
  renderRun(reply?.state ?? null);
}

// An unhandled rejection here leaves the popup half-rendered and silent — the
// tagline still reading "Loading codes…" with no clue why. Say what broke.
void main().catch((error: unknown) => {
  planSummary.textContent = `Could not start up: ${error instanceof Error ? error.message : String(error)}`;
  planSummary.classList.add('is-warning');
  runBtn.disabled = true;
});
