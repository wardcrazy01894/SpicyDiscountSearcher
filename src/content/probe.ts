import { extractOffers } from '../core/extract.js';
import type { ProbeAssignment, ProbeRequest } from '../core/messages.js';
import type { Offer } from '../core/types.js';

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
/** Two identical reads in a row is our stand-in for "the page settled". */
const STABLE_READS_REQUIRED = 2;

function send(message: ProbeRequest): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Background went away mid-run; nothing useful to do from here.
  });
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

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let offers: Offer[] = [];
    try {
      offers = extractOffers(document, assignment.vendor);
    } catch (error) {
      send({
        type: 'PROBE_FAILED',
        message: error instanceof Error ? error.message : String(error),
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

    if (stableReads >= STABLE_READS_REQUIRED - 1) {
      send({ type: 'PROBE_RESULT', offers });
      return;
    }
  }

  // Out of time. Partial results still beat nothing.
  if (latest.length > 0) send({ type: 'PROBE_RESULT', offers: latest });
  else send({ type: 'PROBE_FAILED', message: 'no prices found before timeout' });
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
