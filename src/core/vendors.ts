import type { Category, Vendor, VendorId } from './types.js';

export const VENDORS: Vendor[] = [
  {
    id: 'hertz',
    label: 'Hertz',
    category: 'car',
    codeLabel: 'CDP',
    host: 'www.hertz.com',
    searchable: true,
  },
  {
    id: 'avis',
    label: 'Avis',
    category: 'car',
    codeLabel: 'AWD',
    host: 'www.avis.com',
    searchable: true,
    // Capped, and the route to that answer is worth keeping because it went the
    // other way first. Avis looked like national and enterprise: probe tabs
    // share one profile, `reset-widget-state.ts` clears a localStorage key on
    // every one of them, and if that key carried the AWD then tab A could price
    // tab B's code — which `verify-trip.ts` cannot catch, since it compares only
    // locations and both tabs ask for the same trip.
    //
    // Measured on 2026-08-11, one TPA round trip, tabs loaded concurrently. Two
    // tabs on different AWDs: the code travels in sessionStorage, per-tab by the
    // platform's own rules, and each tab's `reservation.store` and
    // `REACT_QUERY_OFFLINE_CACHE` held its own code and not the other's, found
    // by enumerating every key in both stores. The only localStorage keys
    // carrying an AWD are a bot-detection event log and an mParticle analytics
    // batch queue — write-side telemetry. And `booking-widget.store`, the key
    // this worry named and the one we clear, is 65 bytes carrying no code at
    // all, which an earlier truncated dump could not establish.
    //
    // That was read as "no cap needed" for two rounds. It does not support that,
    // and the gap is the whole reason this comment is long. What it closes is
    // the *client-side* worry. What it leaves open is a cookie-identified
    // backend session pricing both tabs off one code — and no experiment can
    // close that one, because nothing observable varies with the code at all:
    // identical cheapest six with two real AWDs, with the nonsense `Z9Z9Z9Z`,
    // and with no code. The tempting counter-evidence, that a coded tab renders
    // "Your savings are reflected below" and an uncoded one does not, is worth
    // nothing: `Z9Z9Z9Z` renders it too, so it echoes our own request rather
    // than reporting a server verdict.
    //
    // So the risk that matters is unfalsifiable rather than absent. That alone
    // would justify capping every vendor in this file, which is not an argument;
    // what makes it one is specific to Avis. **This vendor has already been
    // caught preferring remembered state to the URL** — the Tampa/Philadelphia
    // bug, where a saved booking widget outranked the query string and priced a
    // journey nobody asked for, which is why `reset-widget-state.ts` exists.
    //
    // Be precise about what that does and does not transfer, because a first
    // draft of this comment was not. The location leaked through
    // `booking-widget.store`, in **localStorage**; the code lives in
    // `reservation.store` and `REACT_QUERY_OFFLINE_CACHE`, in **sessionStorage**.
    // Different stores, and the demonstrated leak vector provably does not carry
    // the code — that is the measurement above. What transfers is not the vector
    // but the vendor's disposition: Avis is a site that has been observed
    // letting remembered state beat an explicit URL parameter, which is exactly
    // the shape of the one risk left untestable here. Hertz has never been
    // observed doing anything of the kind.
    //
    // Sharpening it: "no Avis code has been shown to move a price" (CLAUDE.md)
    // is itself consistent with a shared session overriding the URL's
    // `awd_number`, which would make an uncapped Avis actively wrong rather than
    // merely unproven. Halved throughput is a cost the user can see; one
    // company's price under another's code is not. `enterprise` below takes the
    // same cap on thinner grounds — analogy to National, no measurement at all.
    maxLanes: 1,
    //
    // The widget clear is still needed and is a separate thing: that store holds
    // the *location*, which is the Tampa/Philadelphia bug it was written for.
  },
  {
    id: 'budget',
    label: 'Budget',
    category: 'car',
    codeLabel: 'BCD',
    host: 'www.budget.com',
    // Not searchable: the site ignores the query string entirely, so no deep
    // link can express a search. Same treatment as starwood — the codes stay in
    // the database, but the vendor gets no chip, no candidates and no host
    // permission. Leaving it searchable while its builder throws was worse than
    // either: interleaveByVendor round-robins one candidate per vendor, so
    // three doomed vendors took *half* the default cap of 12 and the plan line
    // promised codes the popup already knew could not run.
    searchable: false,
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    category: 'car',
    codeLabel: 'Corporate account',
    host: 'www.enterprise.com',
    // Not searchable: the site ignores the query string entirely, so no deep
    // link can express a search. Same treatment as starwood — the codes stay in
    // the database, but the vendor gets no chip, no candidates and no host
    // permission. Leaving it searchable while its builder throws was worse than
    // either: interleaveByVendor round-robins one candidate per vendor, so
    // three doomed vendors took *half* the default cap of 12 and the plan line
    // promised codes the popup already knew could not run.
    searchable: false,
    // The workbook stores one shared "Enterprise / National" column. Kept even
    // though both ends are unsearchable today, because it is a fact about the
    // data rather than about whether we can search it.
    alsoTryAs: ['national'],
    // Enterprise keeps its search in session state the same way National does,
    // so the same cap applies for the same reason — set now, while the evidence
    // is written down, rather than discovered again when its driver lands.
    maxLanes: 1,
  },
  {
    id: 'national',
    label: 'National',
    category: 'car',
    codeLabel: 'Contract ID',
    host: 'www.nationalcar.com',
    // Searchable by driver rather than by deep link. Its URL carries nothing;
    // `drivers/national.ts` fills the form in and verifies every field against
    // what the form renders back, including that the results page names the
    // account the code belongs to. Proved against the live site with a
    // controlled differential — same trip, same session: $70.30/day with the
    // code against $74.00/day without, same vehicle, same result count.
    searchable: true,
    // Measured, not assumed. Reloading National's form showed the previous
    // search's location, dates *and* account number still in place, and tabs in
    // one profile share that state — so two lanes racing two codes can settle
    // on one, and the popup would report one company's price under another's
    // code. The results page's own `ACCOUNT NAME` cannot catch it either: both
    // tabs would render the same name.
    maxLanes: 1,
  },
  {
    id: 'sixt',
    label: 'Sixt',
    category: 'car',
    codeLabel: 'Corporate code',
    host: 'www.sixt.com',
    // Not searchable, and this reverses a close call that was recorded here as
    // a close call. Its deep link is *measured* to reach no search:
    // `/php/reservation` 302s to the site root with the location ignored, the
    // dates ignored, and a marketing "$35" on the page.
    //
    // It stayed enabled on the argument that the damage was contained —
    // `landedElsewhere` flags a home-page landing `suspect` and `compare.ts`
    // keeps suspect quotes out of the ranking. Two things wrong with that. The
    // containment is a measurement, not a property: it holds only while the
    // redirect target is the bare root, and a locale split to `/en/` would put
    // that $35 back into the ranking with nothing on screen to say so. And a
    // vendor that cannot answer still spends a lane and a real tab on every
    // run, now against a codes cap of 100 rather than 12.
    //
    // Same treatment as budget and enterprise: the three codes stay in the
    // database, the vendor gets no chip, no candidates and no host permission.
    // Dropping sixt.com from the manifest is a real reduction in what this
    // extension may read. No company loses its car listing and none vanishes —
    // every company with a Sixt code has one at another car vendor too.
    //
    // It comes back the day someone captures a URL that reaches a real search,
    // or writes it a driver. Unlike budget and enterprise, nothing proves it
    // *cannot* work — only that the one path anybody tried does not.
    searchable: false,
  },
  {
    id: 'hilton',
    label: 'Hilton',
    category: 'hotel',
    codeLabel: 'Corporate ID',
    host: 'www.hilton.com',
    searchable: true,
  },
  {
    id: 'marriott',
    label: 'Marriott',
    category: 'hotel',
    codeLabel: 'Corp code',
    host: 'www.marriott.com',
    searchable: true,
  },
  {
    id: 'hyatt',
    label: 'Hyatt',
    category: 'hotel',
    codeLabel: 'Corporate code',
    host: 'www.hyatt.com',
    searchable: true,
  },
  {
    id: 'starwood',
    label: 'Starwood (legacy)',
    category: 'hotel',
    codeLabel: 'SET number',
    host: 'www.marriott.com',
    // Starwood was absorbed into Marriott in 2018; these numbers are kept for
    // reference but there is no Starwood site left to price-check against.
    searchable: false,
  },
];

const BY_ID = new Map<VendorId, Vendor>(VENDORS.map((v) => [v.id, v]));

/**
 * Lookup that tolerates an id the registry no longer knows.
 *
 * For rendering a persisted snapshot: getVendor throws, and one unknown id in
 * one row would take out the whole results list rather than that row.
 */
export function findVendor(id: string): Vendor | undefined {
  return BY_ID.get(id as VendorId);
}

export function getVendor(id: VendorId): Vendor {
  const vendor = BY_ID.get(id);
  if (!vendor) throw new Error(`unknown vendor: ${id}`);
  return vendor;
}

export function vendorsFor(category: Category): Vendor[] {
  return VENDORS.filter((v) => v.category === category && v.searchable);
}

export function searchableVendors(): Vendor[] {
  return VENDORS.filter((v) => v.searchable);
}

/** Every host the extension needs permission to read prices from. */
export function vendorHosts(): string[] {
  return [...new Set(searchableVendors().map((v) => v.host))].sort();
}
