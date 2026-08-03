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
  },
  {
    id: 'national',
    label: 'National',
    category: 'car',
    codeLabel: 'Contract ID',
    host: 'www.nationalcar.com',
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
    id: 'sixt',
    label: 'Sixt',
    category: 'car',
    codeLabel: 'Corporate code',
    host: 'www.sixt.com',
    searchable: true,
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
