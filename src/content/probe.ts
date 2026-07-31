import { extract } from '../core/extract.js';
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

function fingerprint(offers: Offer[]): string {
  return offers
    .map((o) => `${o.label ?? ''}|${o.amount}|${o.basis}`)
    .sort()
    .join(';');
}

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
      await send({ type: 'PROBE_RESULT', offers, report: report(offers, path) });
      return;
    }
  }

  // Out of time. Partial results still beat nothing.
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
