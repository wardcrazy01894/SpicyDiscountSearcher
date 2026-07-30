import { buildCandidates, countCodesFor, searchCompanies } from '../core/codes.js';
import { classMatrix, rankQuotes, savings } from '../core/compare.js';
import type { PopupRequest, StateMessage } from '../core/messages.js';
import type {
  Candidate,
  Category,
  Quote,
  RunState,
  SearchPlan,
  Trip,
  VendorId,
} from '../core/types.js';
import { vendorsFor } from '../core/vendors.js';

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
}

const ui: UiState = {
  category: 'car',
  vendors: new Set<VendorId>(),
  companies: new Set<string>(),
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

function renderCompanyList(): void {
  const query = companySearch.value;
  const vendors = [...ui.vendors];
  const matches = searchCompanies(query).filter((company) =>
    company.codes.some((code) => code.code && vendors.includes(code.vendor)),
  );

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = query
      ? `No company matching "${query}" has a code for these vendors.`
      : 'Pick at least one vendor.';
    companyList.replaceChildren(empty);
    return;
  }

  // Long lists make the popup crawl; the search box is how you reach the rest.
  const shown = matches.slice(0, 60);
  companyList.replaceChildren(
    ...shown.map((company) => {
      const row = document.createElement('label');
      row.className = 'company';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ui.companies.has(company.slug);
      box.addEventListener('change', () => {
        if (box.checked) ui.companies.add(company.slug);
        else ui.companies.delete(company.slug);
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

function plannedCandidates(): { all: Candidate[]; capped: Candidate[]; max: number } {
  const max = Math.max(1, Number(maxCodesInput.value) || 1);
  const all = buildCandidates({
    vendors: [...ui.vendors],
    companySlugs: [...ui.companies],
  });
  return { all, capped: all.slice(0, max), max };
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
  runBtn.disabled = false;
  const truncated = all.length > capped.length;
  planSummary.textContent = truncated
    ? `${all.length} codes match ${scope} — racing the first ${capped.length}. Narrow the list or raise the cap to try more.`
    : `Racing ${capped.length} code${capped.length === 1 ? '' : 's'} across ${scope}.`;
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

function renderQuote(quote: Quote, winnerId: string | null): HTMLLIElement {
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
      basis.textContent = quote.best.basis === 'per-day' ? ' /day' : ' (basis unclear)';
      right.append(basis);
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
  cancelBtn.hidden = !running;
  runBtn.disabled = running;
  runBtn.textContent = running ? 'Racing codes…' : 'Find the cheapest code';

  if (!state) {
    results.hidden = true;
    return;
  }
  results.hidden = false;

  const ranked = rankQuotes(state.quotes);
  const winner = ranked.find((q) => q.status === 'ok' && q.best) ?? null;
  quotesList.replaceChildren(...ranked.map((quote) => renderQuote(quote, winner?.id ?? null)));

  const spread = savings(state.quotes);
  if (spread && winner?.best) {
    savingsBox.hidden = false;
    savingsBox.replaceChildren();
    const line = document.createElement('div');
    line.innerHTML = `Cheapest is <strong>${winner.candidate.companyName}</strong> (${winner.candidate.code}) at <strong>${money(spread.best, winner.best.currency)}</strong> — ${money(spread.absolute, winner.best.currency)} (${spread.percent.toFixed(0)}%) under the priciest code that answered.`;
    savingsBox.append(line);

    // Flag the case where the winner is only cheap because it surfaced a
    // different class of car than the others did.
    const shared = classMatrix(state.quotes).filter((row) => row.amounts.size > 1);
    const winnerWinsShared = shared.some((row) => row.bestQuoteId === winner.id);
    if (shared.length > 0 && !winnerWinsShared) {
      const caveat = document.createElement('p');
      caveat.className = 'hint is-warning';
      caveat.textContent =
        'Heads up: another code is cheaper on the classes these results have in common, so this winner may just be showing a different vehicle.';
      savingsBox.append(caveat);
    }
  } else {
    savingsBox.hidden = true;
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

  if (saved.category) ui.category = saved.category;
  if (saved.vendors?.length) ui.vendors = new Set(saved.vendors);
  if (saved.companies?.length) ui.companies = new Set(saved.companies);
  if (saved.maxCodes) maxCodesInput.value = saved.maxCodes;
  if (saved.concurrency) concurrencyInput.value = saved.concurrency;

  for (const [key, value] of Object.entries(saved.fields ?? {})) {
    const input = form.elements.namedItem(key);
    if (input instanceof HTMLInputElement) input.value = value;
  }
}

function setCategory(category: Category): void {
  ui.category = category;
  ui.vendors.clear();
  ui.companies.clear();
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

void main();
