import { describe, expect, it } from 'vitest';

import {
  allCompanies,
  buildCandidates,
  codeDatabase,
  companyBySlug,
  countCodesFor,
  interleaveByVendor,
  searchCompanies,
} from '../src/core/codes.js';
import type { Candidate } from '../src/core/types.js';
import { VENDORS, vendorsFor } from '../src/core/vendors.js';

const VENDOR_IDS = new Set(VENDORS.map((v) => v.id));

describe('the generated code database', () => {
  it('parsed exactly the rows the workbook holds', () => {
    // Exact, not a floor. Floors of 150/400 against real values of 225/546 let
    // extract_codes.py drop a quarter of the workbook and still ship green,
    // which is the regression the comment claimed to guard. The CI data job
    // already pins this JSON byte-for-byte to the workbook, so a legitimate
    // workbook edit updates both numbers together and nothing else can move
    // them.
    const companies = allCompanies();
    expect(companies.length).toBe(217);
    expect(companies.flatMap((c) => c.codes).length).toBe(546);
  });

  it('only references vendors the extension knows about', () => {
    for (const company of allCompanies()) {
      for (const record of company.codes) {
        expect(VENDOR_IDS.has(record.vendor)).toBe(true);
      }
    }
  });

  it('stores codes normalised and free of spreadsheet artefacts', () => {
    for (const company of allCompanies()) {
      for (const record of company.codes) {
        if (record.code === null) {
          // A null code is only allowed when the workbook gave a booking URL.
          expect(record.url).toBeTruthy();
          continue;
        }
        expect(record.code).toBe(record.code.toUpperCase());
        expect(record.code).toMatch(/^[A-Z0-9][A-Z0-9+-]{1,15}$/);
        // Excel's float coercion turned 260290 into "260290.0"; the parser
        // must have undone that.
        expect(record.code).not.toMatch(/\.0$/);
      }
    }
  });

  it('has a unique slug per company', () => {
    const slugs = allCompanies().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps a stable schema version', () => {
    expect(codeDatabase().schemaVersion).toBe(1);
  });

  it('carries the codes we know are in the workbook', () => {
    const deloitte = companyBySlug('deloitte');
    expect(deloitte?.codes.some((c) => c.vendor === 'marriott' && c.code === 'DTC')).toBe(true);
    expect(deloitte?.codes.some((c) => c.vendor === 'hertz' && c.code === '1409996')).toBe(true);

    const accenture = companyBySlug('accenture');
    expect(accenture?.codes.some((c) => c.vendor === 'marriott' && c.code === 'ACC')).toBe(true);
  });
});

describe('company names', () => {
  it('publishes no margin notes as employers', () => {
    // The workbook's first column is a name column by convention only: it also
    // held "(Americas only)", "(LON, AMS)" and a sentence about breakfast,
    // each of which reached the picker as a company you could select.
    for (const company of allCompanies()) {
      expect(company.name).not.toMatch(/^\(|%|\.\s/);
      // Matches MAX_NAME_WORDS in extract_codes.py; two different limits meant
      // a name the parser accepts could still fail here.
      expect(company.name.split(/\s+/).length).toBeLessThanOrEqual(8);
    }
  });

  it('keeps the codes those notes were attached to', () => {
    // They are real Hilton codes; only the attribution was invented. Dropping
    // them would trade working codes for a naming fix.
    const unattributed = allCompanies().find((c) => c.name === 'Unattributed');
    expect(unattributed?.codes.length).toBeGreaterThan(0);
    expect(unattributed?.codes.every((c) => c.note)).toBe(true);
  });
});

describe('searchCompanies', () => {
  it('ranks prefix matches ahead of mid-string ones', () => {
    const results = searchCompanies('del');
    expect(results[0]?.name.toLowerCase().startsWith('del')).toBe(true);
  });

  it('returns everything for an empty query', () => {
    expect(searchCompanies('  ').length).toBe(allCompanies().length);
  });

  it('finds nothing for nonsense', () => {
    expect(searchCompanies('zzzzzznotacompany')).toEqual([]);
  });
});

describe('countCodesFor', () => {
  it('agrees with a manual count', () => {
    const manual = allCompanies()
      .flatMap((c) => c.codes)
      .filter((c) => c.vendor === 'marriott' && c.code).length;
    expect(countCodesFor('marriott')).toBe(manual);
  });
});

describe('buildCandidates', () => {
  it('produces one candidate per distinct vendor+code pair', () => {
    const candidates = buildCandidates({ vendors: ['marriott'] });
    const keys = candidates.map((c) => `${c.vendor}:${c.code}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(candidates.every((c) => c.vendor === 'marriott')).toBe(true);
  });

  it('credits every company that lists a shared code', () => {
    // B406790 appears under both Accenture and PwC in the workbook.
    const shared = buildCandidates({ vendors: ['avis'] }).find((c) => c.code === 'B406790');
    expect(shared?.companyName).toContain('Accenture');
    expect(shared?.companyName).toContain('PwC');
  });

  it('tries Enterprise contract ids at National too', () => {
    const candidates = buildCandidates({ vendors: ['enterprise'] });
    expect(candidates.some((c) => c.vendor === 'national')).toBe(true);
    // The same code should appear once per brand, not merged into one.
    const pwc = candidates.filter((c) => c.code === 'XZ42PWC').map((c) => c.vendor);
    expect(pwc.sort()).toEqual(['enterprise', 'national']);
  });

  it('never proposes a code for an unsearchable vendor', () => {
    expect(buildCandidates({ vendors: ['starwood'] })).toEqual([]);
  });

  it('honours a company filter', () => {
    const candidates = buildCandidates({ vendors: ['marriott'], companySlugs: ['deloitte'] });
    expect(candidates.map((c) => c.code)).toContain('DTC');
    expect(candidates.length).toBeLessThan(10);
  });
});

describe('interleaveByVendor', () => {
  const candidate = (
    vendor: Candidate['vendor'],
    code: string,
    slug = code.toLowerCase(),
  ): Candidate => ({
    companySlug: slug,
    companyName: slug,
    vendor,
    code,
    note: null,
  });

  it('gives every vendor a turn before any vendor gets a second', () => {
    const spread = interleaveByVendor([
      candidate('avis', 'A1'),
      candidate('avis', 'A2'),
      candidate('avis', 'A3'),
      candidate('hertz', 'H1'),
      candidate('sixt', 'S1'),
    ]);
    expect(spread.map((c) => c.code)).toEqual(['A1', 'H1', 'S1', 'A2', 'A3']);
  });

  it('reorders within a lane only to reach an uncovered company', () => {
    // Not "order within a vendor is preserved" — that guarantee is gone, and
    // is incompatible with spreading across companies. A1 and A2 share a
    // company, so A3's fresh one is pulled forward past A2.
    const spread = interleaveByVendor([
      candidate('avis', 'A1', 'acme'),
      candidate('avis', 'A2', 'acme'),
      candidate('avis', 'A3', 'globex'),
    ]);
    expect(spread.map((c) => c.code)).toEqual(['A1', 'A3', 'A2']);
  });

  it('loses nothing and invents nothing', () => {
    const all = buildCandidates({ vendors: vendorsFor('car').map((v) => v.id) });
    const spread = interleaveByVendor(all);
    expect(spread.length).toBe(all.length);
    expect(new Set(spread.map((c) => `${c.vendor}:${c.code}`))).toEqual(
      new Set(all.map((c) => `${c.vendor}:${c.code}`)),
    );
  });

  it('handles an empty selection', () => {
    expect(interleaveByVendor([])).toEqual([]);
  });

  it('prefers a company the run has not covered yet', () => {
    // The consultancies have a code at nearly every vendor, so a plain vendor
    // round robin picked the same one from every lane.
    const spread = interleaveByVendor([
      candidate('avis', 'A1', 'accenture'),
      candidate('avis', 'A2', 'bain'),
      candidate('hertz', 'H1', 'accenture'),
      candidate('hertz', 'H2', 'comcast'),
      candidate('sixt', 'S1', 'accenture'),
      candidate('sixt', 'S2', 'danaher'),
    ]);
    expect(new Set(spread.slice(0, 3).map((c) => c.companySlug)).size).toBe(3);
  });

  it('still takes a repeat company when a lane has nothing fresh left', () => {
    const spread = interleaveByVendor([
      candidate('avis', 'A1', 'accenture'),
      candidate('hertz', 'H1', 'accenture'),
    ]);
    expect(spread).toHaveLength(2);
    expect(spread.map((c) => c.code)).toEqual(['A1', 'H1']);
  });

  it('makes the default cap race more than one vendor', () => {
    // The bug this exists to prevent: buildCandidates sorts by vendor, so
    // slicing the first 12 raced twelve Avis codes and nothing else — no
    // comparison across vendors happened at default settings at all.
    const carVendors = vendorsFor('car').map((v) => v.id);
    const all = buildCandidates({ vendors: carVendors });
    const raced = interleaveByVendor(all).slice(0, 12);

    const perVendor = new Map<string, number>();
    for (const candidate of raced) {
      perVendor.set(candidate.vendor, (perVendor.get(candidate.vendor) ?? 0) + 1);
    }
    // Compared against the vendors that actually have candidates, not against
    // the registry: a vendor added to vendors.ts before its codes land in the
    // workbook is not this function's fault. `ceil(12 / perVendor.size)` looks
    // stricter but lets two vendors take six each — the very shape of the bug
    // this guards — and goes red merely because a lane runs short.
    const withCodes = new Set(all.map((c) => c.vendor));
    expect(perVendor.size).toBe(withCodes.size);
    expect(Math.max(...perVendor.values())).toBeLessThanOrEqual(3);
  });

  it('spreads the default cap across companies, not just vendors', () => {
    // Cycling vendors alone put seven of the first twelve on one company: the
    // big consultancies have a code at nearly every vendor, so every lane
    // offered the same name first.
    const carVendors = vendorsFor('car').map((v) => v.id);
    const raced = interleaveByVendor(buildCandidates({ vendors: carVendors })).slice(0, 12);
    // All 12 distinct today, but pinned a little below that: one company
    // gaining a code at another vendor is a workbook edit, not a regression
    // here, and 10 is still decisive against the 4 this replaced.
    expect(new Set(raced.map((c) => c.companySlug)).size).toBeGreaterThanOrEqual(10);
  });
});
