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

/** Case-insensitive substring match on company name, ordered best-first. */
export function searchCompanies(query: string, vendor?: VendorId): Company[] {
  const needle = query.trim().toLowerCase();
  const pool = vendor
    ? DB.companies.filter((c) => c.codes.some((code) => code.vendor === vendor && code.code))
    : DB.companies;
  if (!needle) return pool;
  const matches = pool.filter((c) => c.name.toLowerCase().includes(needle));
  // Prefix matches are almost always what someone typing "del" wants.
  return matches.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    return aPrefix - bPrefix || a.name.localeCompare(b.name);
  });
}

export function countCodesFor(vendor: VendorId): number {
  let total = 0;
  for (const company of DB.companies) {
    for (const record of company.codes) {
      if (record.vendor === vendor && record.code) total += 1;
    }
  }
  return total;
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
 * Reorder candidates so that taking the first N gives every vendor a turn.
 *
 * buildCandidates groups by vendor, which is the right order to read but the
 * wrong one to truncate: the popup races only the first N, so with the default
 * cap of 12 a car run was twelve Avis codes and nothing else, and a hotel run
 * twelve Hilton codes. Racing codes against each other *within one vendor* is
 * not the comparison this tool exists to make.
 *
 * Order within a vendor is preserved, so the cap still takes that vendor's
 * alphabetically-first companies — only the spread across vendors changes.
 */
export function interleaveByVendor(candidates: Candidate[]): Candidate[] {
  const queues = new Map<VendorId, Candidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.vendor) ?? [];
    queue.push(candidate);
    queues.set(candidate.vendor, queue);
  }

  const lanes = [...queues.values()];
  const longest = lanes.reduce((max, lane) => Math.max(max, lane.length), 0);
  const out: Candidate[] = [];
  for (let round = 0; round < longest; round += 1) {
    for (const lane of lanes) {
      const next = lane[round];
      if (next) out.push(next);
    }
  }
  return out;
}
