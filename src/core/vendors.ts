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
    // Deliberately **no `maxLanes`**, and now on evidence rather than on the
    // absence of it. Avis looked like national and enterprise: probe tabs share
    // one profile, `reset-widget-state.ts` clears a localStorage key on every
    // one of them, and if that key carried the AWD then tab A could price tab
    // B's code — which `verify-trip.ts` is structurally blind to, since it only
    // compares locations and both tabs ask for the same trip.
    //
    // Measured on 2026-08-11, on one TPA round trip, tabs loaded concurrently.
    //
    // The settling evidence is *rendered*, not introspected: a tab carrying an
    // AWD and a tab carrying none, side by side, produced different pages — only
    // the coded one said "Your savings are reflected below". Two concurrent tabs
    // disagreeing on screen rules out every shared-state vector at once, cookies
    // and IndexedDB included, neither of which had to be enumerated.
    //
    // The mechanism, from a second pair on two *different* AWDs: the code
    // travels in sessionStorage, which is per-tab. Each tab's
    // `reservation.store` and `REACT_QUERY_OFFLINE_CACHE` held its own code and
    // not the other's, found by enumerating every key in both stores. The only
    // localStorage keys carrying an AWD are a bot-detection event log and an
    // mParticle analytics batch queue — write-side telemetry, not read back to
    // price a search. And `booking-widget.store`, the key the suspicion was
    // actually about and the one we clear, is 65 bytes and carries no code at
    // all. That last fact is what an earlier truncated dump could not settle.
    //
    // Both halves are needed. The banner separates a coded tab from an uncoded
    // one, not code A from code B; the storage partition is what covers two
    // tabs both carrying codes, which is what a real run produces.
    //
    // Prices did *not* discriminate: identical cheapest six with either code and
    // with none. So the banner proves the code was accepted, not that it saved
    // anything — worth knowing, and not a fact about lanes.
    //
    // The clear itself is still needed: that store holds the *location*, which
    // is the Tampa/Philadelphia bug it was written for.
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
