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
    // Searchable since 2026-08-12, by **driver rather than deep link** — its
    // URL still carries nothing and never will, exactly like National's. What
    // changed is that `drivers/enterprise.ts` can now express the whole trip:
    // the calendar was measured and driven, and so were the time dropdowns it
    // used to leave at their noon defaults.
    //
    // The three things that had to land with this flag: the driver registered
    // in `FORM_DRIVERS`, the builder returning its start URL instead of
    // throwing, and `probeTimeoutMs` below.
    searchable: true,
    // The workbook stores one shared "Enterprise / National" column, and it is
    // the *only* place these codes live — there is no `vendor: 'national'`
    // record at all, so National's 19 codes all arrive through here.
    alsoTryAs: ['national'],
    // Enterprise's widget hydrates slowly and unpredictably: instant on one
    // profile, ~40s on another, never on a third. 45s of total budget, of which
    // a driver gets `DRIVE_SHARE`, cannot cover a 40s mount plus a fill plus a
    // priced results page. 120s can, and costs nothing at the vendors that
    // answer quickly because it is per-vendor.
    //
    // Not a fix for the never-mounted case, which is a bot check or a blocked
    // script rather than slowness — that surfaces as `form-fill` naming the
    // hydration wait, which is the honest answer.
    probeTimeoutMs: 120_000,
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
    // Not searchable, and as of 2026-08-12 **closed rather than open**. The
    // note that stood here was the close-call version: `/php/reservation` 302s
    // to the site root, one path measured once, so "it comes back the day
    // someone captures a URL that reaches a real search". Someone did capture
    // one. That is why this is rewritten rather than amended — the old text
    // pointed at the wrong obstacle and sent a reader hunting for a URL that
    // turned out to exist and not to help.
    //
    // What was measured: `/betafunnel/#/offerlist` searches properly on a
    // `BRANCH:<id>` and replays under a deliberately wrong title. But **no
    // corporate-code field exists anywhere in Sixt's funnel**, and its
    // corporate surface is all account login and registration, so a code like
    // Deloitte's `19145742` appears to need a business account we do not have.
    // A driver does not rescue it either: there is no field to drive.
    // `deeplinks.ts` carries the parameters and the full reasoning.
    //
    // Racing it uncoded, for its retail rate, was considered and declined the
    // same day: `BRANCH:<id>` is not derivable from an IATA code and LAX has no
    // single branch at all, so it needs a hand-captured lookup table that would
    // rot silently — for a rate nothing suggests beats the codes we do race.
    //
    // Same treatment as budget and enterprise: the three codes stay in the
    // database, the vendor gets no chip, no candidates and no host permission.
    // Dropping sixt.com from the manifest is a real reduction in what this
    // extension may read. No company loses its car listing and none vanishes —
    // every company with a Sixt code has one at another car vendor too.
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
