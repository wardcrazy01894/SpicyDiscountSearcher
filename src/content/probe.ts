import { extract } from '../core/extract.js';
import { checkTrip } from '../core/verify-trip.js';
import type { ProbeAssignment, ProbeRequest } from '../core/messages.js';
import type { Offer, ProbeReport } from '../core/types.js';

/**
 * Injected into every vendor site, but deliberately inert unless the background
 * says this tab belongs to a running price race. Browsing Hertz normally should
 * cost nothing.
 *
 * Vendor pages fill in prices asynchronously and often re-render once or twice
 * as availability settles, so rather than reading the DOM once, this polls until
 * the numbers stop moving.
 */

const POLL_INTERVAL_MS = 1_500;
const RETRY_DELAY_MS = 250;
/** Repeats, not reads: one repeat means two identical reads in a row. The
 * constant used to say 2 and be compared as `>= STABLE_READS_REQUIRED - 1`,
 * so the name and the arithmetic disagreed about what was being counted. */
const STABLE_REPEATS_REQUIRED = 1;

/**
 * Deliver the one payload this script exists to produce, with a single retry.
 *
 * Swallowing a failure here does not lose a log line, it loses the result: the
 * background's timer then fires and the user is told "timed out before any
 * price appeared" for a page where prices were found and parsed. That is worse
 * than no diagnosis — it is a confident wrong one. A rejection is usually the
 * service worker mid-restart, which a moment's wait resolves.
 */
async function send(message: ProbeRequest): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await chrome.runtime.sendMessage(message);
      return;
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  // Two failures means the background is genuinely gone; it will time this
  // quote out on its own, and there is no one left here to tell.
}

/** Path only — the query string carries the discount code and the itinerary. */
function report(offers: Offer[], path: ProbeReport['path']): ProbeReport {
  return {
    finalPath: location.pathname,
    title: document.title.slice(0, 120),
    offerCount: offers.length,
    path,
  };
}

/**
 * A sentence naming the mismatch, or null when the page is describing our trip.
 *
 * Returns the message rather than a boolean so the popup's tooltip can say
 * which location turned up — "the page priced a different trip" is a verdict,
 * and the code the page actually showed is the evidence for it.
 */
function wrongTrip(assignment: Extract<ProbeAssignment, { type: 'PROBE_START' }>): string | null {
  if (!VERIFY_TRIP.has(assignment.vendor)) return null;
  try {
    // `innerText` is layout-aware and is what renders the summary as one line;
    // `textContent` is the fallback because jsdom implements only the latter,
    // which is what made this check untestable — and therefore untested — when
    // it was first written.
    const text = document.body.innerText ?? document.body.textContent ?? '';
    const { rendered, unexpected } = checkTrip(assignment.trip, text);
    if (!unexpected) return null;
    return `page shows ${rendered.join(', ')}, which is not the trip requested`;
  } catch {
    // A throw here must not become silence. Without this the rejection escapes
    // `probe()`, `void main()` swallows it, nothing is ever sent, and the
    // background reports `probe-timeout` — "no answer before the deadline" —
    // about a page that had already parsed its prices. That is the confident
    // wrong diagnosis the retry in `send()` exists to prevent, arriving by a
    // different door. A check that cannot run is not evidence of a bad trip.
    return null;
  }
}

function fingerprint(offers: Offer[]): string {
  return offers
    .map((o) => `${o.label ?? ''}|${o.amount}|${o.basis}`)
    .sort()
    .join(';');
}

/**
 * Vendors whose results page states the trip plainly enough to check against.
 *
 * Opt-in per vendor for the same reason `VENDOR_SELECTORS` is: it reads a
 * summary the vendor happens to render, which rots, and a false "wrong trip"
 * throws away a good quote. Avis is here because it is the vendor observed
 * pricing a different rental from the one asked for.
 */
const VERIFY_TRIP = new Set<string>(['avis']);

async function probe(assignment: Extract<ProbeAssignment, { type: 'PROBE_START' }>) {
  const deadline = Date.now() + assignment.timeoutMs;
  let previous = '';
  let stableReads = 0;
  let latest: Offer[] = [];
  let path: ProbeReport['path'] = 'generic-sweep';

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    // No initialiser: the catch below returns, so every path that reaches the
    // read has assigned it. eslint 10's no-useless-assignment spotted the dead
    // [] this used to carry.
    let offers: Offer[];
    try {
      const extraction = extract(document, assignment.vendor);
      offers = extraction.offers;
      path = extraction.path;
    } catch (error) {
      await send({
        type: 'PROBE_FAILED',
        failure: 'extract-threw',
        message: error instanceof Error ? error.message : String(error),
        report: report([], path),
      });
      return;
    }

    if (offers.length === 0) {
      // Still loading, or the search never ran. Keep waiting.
      previous = '';
      stableReads = 0;
      continue;
    }

    latest = offers;
    const current = fingerprint(offers);
    stableReads = current === previous ? stableReads + 1 : 0;
    previous = current;

    if (stableReads >= STABLE_REPEATS_REQUIRED) {
      // Checked only once the page has settled, and only once prices exist:
      // a summary read mid-render can still be showing the previous search,
      // which would reject a quote that was about to be correct.
      const wrong = wrongTrip(assignment);
      if (wrong) {
        await send({
          type: 'PROBE_FAILED',
          failure: 'wrong-trip',
          message: wrong,
          report: report(offers, path),
        });
        return;
      }
      await send({ type: 'PROBE_RESULT', offers, report: report(offers, path) });
      return;
    }
  }

  // Out of time. Partial results still beat nothing — but not if they describe
  // somebody else's trip.
  const wrongAtDeadline = latest.length > 0 ? wrongTrip(assignment) : null;
  if (wrongAtDeadline) {
    await send({
      type: 'PROBE_FAILED',
      failure: 'wrong-trip',
      message: wrongAtDeadline,
      report: report(latest, path),
    });
    return;
  }
  if (latest.length > 0) {
    await send({ type: 'PROBE_RESULT', offers: latest, report: report(latest, path) });
  } else {
    await send({
      type: 'PROBE_FAILED',
      failure: 'probe-empty',
      message: 'polled to the deadline without seeing a price',
      report: report([], path),
    });
  }
}

async function main(): Promise<void> {
  let assignment: ProbeAssignment;
  try {
    const ready: ProbeRequest = { type: 'PROBE_READY' };
    assignment = await chrome.runtime.sendMessage<ProbeRequest, ProbeAssignment>(ready);
  } catch {
    return; // No background listening — the extension isn't running a search.
  }

  if (!assignment || assignment.type !== 'PROBE_START') return;
  await probe(assignment);
}

void main();
