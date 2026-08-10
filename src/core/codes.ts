import database from '../data/codes.generated.json' with { type: 'json' };
import type { Candidate, CodeDatabase, Company, VendorId } from './types.js';
import { getVendor } from './vendors.js';

const DB = database as unknown as CodeDatabase;

export function codeDatabase(): CodeDatabase {
  return DB;
}

export function allCompanies(): Company[] {
  return DB.companies;
}

export function companyBySlug(slug: string): Company | undefined {
  return DB.companies.find((c) => c.slug === slug);
}

/**
 * Case-insensitive substring match on company name, ordered best-first.
 *
 * No vendor filter: it took one, no caller ever passed it, and the popup
 * reimplemented the same predicate inline because it needs to filter on the
 * several vendors actually selected rather than one.
 */
export function searchCompanies(query: string): Company[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return DB.companies;
  const matches = DB.companies.filter((c) => c.name.toLowerCase().includes(needle));
  // Prefix matches are almost always what someone typing "del" wants.
  return matches.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    return aPrefix - bPrefix || a.name.localeCompare(b.name);
  });
}

/**
 * How many codes this vendor would actually race.
 *
 * Must agree with `buildCandidates`, because the number goes on the vendor's
 * chip and the candidates are what the run does. It disagreed in two ways, and
 * both made the chip a promise the race did not keep:
 *
 * - **`alsoTryAs` was ignored.** The workbook files every Enterprise/National
 *   contract id under Enterprise and contains no `vendor: 'national'` record at
 *   all, so National's chip read **0** while a run really did price 19 codes at
 *   it. Reported from a loaded extension: "National still has a 0 next to it
 *   even though it is searching codes."
 * - **Records were counted, not codes.** Two companies often share one code —
 *   the workbook lists B406790 under both Accenture and PwC — and
 *   `buildCandidates` collapses those into a single candidate crediting both.
 *   Counting the rows overstated every vendor: Avis showed 27 against 23 raced,
 *   Hilton 287 against 279. Pre-existing and much smaller than the National
 *   case, but the same fault, so it is fixed by the same set.
 */
export function countCodesFor(vendor: VendorId): number {
  const codes = new Set<string>();
  for (const company of DB.companies) {
    for (const record of company.codes) {
      if (!record.code) continue;
      // Same reachability rule `buildCandidates` applies, and deliberately not
      // a second copy of it in spirit only: a code filed under one brand counts
      // for every brand that honours it.
      const targets = [record.vendor, ...(getVendor(record.vendor).alsoTryAs ?? [])];
      if (targets.includes(vendor)) codes.add(record.code);
    }
  }
  return codes.size;
}

export interface CandidateQuery {
  vendors: VendorId[];
  /** Empty means every company in the database. */
  companySlugs?: string[];
}

/**
 * Expand a selection into the concrete (vendor, code) pairs worth pricing.
 *
 * Two companies often share a code — the workbook lists B406790 under both
 * Accenture and PwC — and loading the same URL twice would just burn a tab, so
 * duplicates collapse into one candidate that credits every company listing it.
 */
export function buildCandidates(query: CandidateQuery): Candidate[] {
  const wanted = new Set(query.vendors);
  // A code filed under Enterprise is worth trying at National too.
  for (const id of query.vendors) {
    for (const extra of getVendor(id).alsoTryAs ?? []) wanted.add(extra);
  }

  const slugFilter = query.companySlugs?.length ? new Set(query.companySlugs) : null;
  const byKey = new Map<string, Candidate>();
  const contributors = new Map<string, Set<string>>();

  for (const company of DB.companies) {
    if (slugFilter && !slugFilter.has(company.slug)) continue;
    for (const record of company.codes) {
      if (!record.code) continue;
      const targets: VendorId[] = [record.vendor, ...(getVendor(record.vendor).alsoTryAs ?? [])];
      for (const vendor of targets) {
        if (!wanted.has(vendor) || !getVendor(vendor).searchable) continue;
        const key = `${vendor}:${record.code}`;
        const names = contributors.get(key) ?? new Set<string>();
        names.add(company.name);
        contributors.set(key, names);
        if (!byKey.has(key)) {
          byKey.set(key, {
            companySlug: company.slug,
            companyName: company.name,
            vendor,
            code: record.code,
            note: record.note,
          });
        }
      }
    }
  }

  return [...byKey.entries()]
    .map(([key, candidate]) => {
      const names = [...(contributors.get(key) ?? [])].sort();
      return names.length > 1 ? { ...candidate, companyName: names.join(' / ') } : candidate;
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.companyName.localeCompare(b.companyName));
}

/**
 * Reorder candidates so that taking the first N spreads across both vendors
 * and companies.
 *
 * buildCandidates groups by vendor, which is the right order to read but the
 * wrong one to truncate: the popup races only the first N, so with the default
 * cap of 12 a car run was twelve Avis codes and nothing else, and a hotel run
 * twelve Hilton codes. Racing codes against each other *within one vendor* is
 * not the comparison this tool exists to make.
 *
 * Cycling vendors alone is not enough. Each vendor's lane is ordered by company
 * name, and the big consultancies have a code at nearly every vendor — so a
 * plain round robin spent seven of its first twelve slots on one company,
 * trading "one vendor, twelve companies" for "six vendors, four companies".
 * Each pick therefore prefers a company the run has not covered yet, which
 * costs nothing when a lane has no fresh company left to offer.
 */
export function interleaveByVendor(candidates: Candidate[]): Candidate[] {
  const queues = new Map<VendorId, Candidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.vendor) ?? [];
    queue.push(candidate);
    queues.set(candidate.vendor, queue);
  }

  const lanes = [...queues.values()];
  const out: Candidate[] = [];
  const covered = new Set<string>();

  while (out.length < candidates.length) {
    let progressed = false;
    for (const lane of lanes) {
      if (lane.length === 0) continue;
      const fresh = lane.findIndex((candidate) => !covered.has(candidate.companySlug));
      // splice on a non-empty lane at an in-range index always yields one.
      const picked = lane.splice(fresh === -1 ? 0 : fresh, 1)[0]!;
      out.push(picked);
      covered.add(picked.companySlug);
      progressed = true;
    }
    // Every lane is empty; nothing further can be added.
    if (!progressed) break;
  }
  return out;
}
