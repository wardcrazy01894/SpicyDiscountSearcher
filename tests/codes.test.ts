import { describe, expect, it } from 'vitest';

import {
  allCompanies,
  buildCandidates,
  codeDatabase,
  codeReaches,
  companyBySlug,
  countCodesFor,
  interleaveByVendor,
  searchCompanies,
} from '../src/core/codes.js';
import type { Candidate } from '../src/core/types.js';
import { VENDORS, getVendor, vendorsFor } from '../src/core/vendors.js';

const VENDOR_IDS = new Set(VENDORS.map((v) => v.id));

describe('the generated code database', () => {
  it('parsed exactly the rows the workbook holds', () => {
    // Exact, not a floor. Floors of 150/400 against real values of 231/555 let
    // extract_codes.py drop a quarter of the workbook and still ship green,
    // which is the regression the comment claimed to guard. The CI data job
    // already pins this JSON byte-for-byte to the workbook, so a legitimate
    // workbook edit updates both numbers together and nothing else can move
    // them.
    const companies = allCompanies();
    expect(companies.length).toBe(231);
    expect(companies.flatMap((c) => c.codes).length).toBe(555);
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
    //
    // This claim used to be false for four of the nine that lived here: FIAT,
    // LET, ME and ADD were words the Hilton-sheet parser cut off the front of
    // an employer's name and a sentence. They are gone, and the bucket now
    // holds only codes the workbook really did leave unattributed.
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
  it('counts what the vendor would actually race, for every searchable vendor', () => {
    // The chip's number and the run's candidates have to be the same number.
    // They were not, in two ways, and both made the chip a promise the race did
    // not keep — so this is asserted against `buildCandidates` itself rather
    // than against a hand-rolled count that could drift the same way.
    for (const vendor of VENDORS.filter((v) => v.searchable)) {
      const raced = buildCandidates({ vendors: [vendor.id] }).filter((c) => c.vendor === vendor.id);
      expect(countCodesFor(vendor.id), vendor.id).toBe(raced.length);
    }
  });

  it('counts codes a vendor only reaches through alsoTryAs', () => {
    // The reported bug: National's chip read 0 in a loaded extension while the
    // run priced 19 codes at it. Every National code is filed under Enterprise
    // — there is no `vendor: 'national'` record in the workbook at all.
    const filed = allCompanies()
      .flatMap((c) => c.codes)
      .filter((c) => c.vendor === 'national' && c.code);
    expect(filed).toHaveLength(0);
    expect(countCodesFor('national')).toBe(19);
  });

  it('lists a company whose only car code reaches a vendor through alsoTryAs', () => {
    // The popup filters its company list by the same rule, and got it wrong the
    // same way. Selecting National alone hid these eight — the very companies
    // README says vanished when these vendors went unsearchable.
    for (const name of [
      'Michigan State University',
      'Purdue / Big TEN',
      'UNION Bank/MUFG',
      'University of Maryland',
    ]) {
      const company = allCompanies().find((c) => c.name === name);
      expect(company, name).toBeDefined();
      const reachable = company!.codes.some(
        (code) => code.code && codeReaches(code.vendor, 'national'),
      );
      expect(reachable, name).toBe(true);
      // And they have nothing at any other *reachable* car vendor, which is what
      // made the omission total rather than cosmetic. Derived from the registry
      // rather than listed: it named sixt until that vendor was disabled, and a
      // hard-coded list quietly asserts something about vendors nothing routes
      // to — passing today, and failing on a workbook edit with a message
      // claiming a code is reachable when it is not.
      const otherCarVendors = VENDORS.filter(
        (v) => v.category === 'car' && v.searchable && v.id !== 'national',
      ).map((v) => v.id);
      const elsewhere = company!.codes.some(
        (code) => code.code && otherCarVendors.some((v) => codeReaches(code.vendor, v)),
      );
      expect(elsewhere, name).toBe(false);
    }
  });

  it('counts a code shared by two companies once', () => {
    // B406790 is filed under both Accenture and PwC; `buildCandidates` collapses
    // them into one candidate crediting both, so counting the rows overstated
    // every vendor — Avis read 27 against 23 raced.
    const rows = allCompanies()
      .flatMap((c) => c.codes)
      .filter((c) => c.vendor === 'avis' && c.code).length;
    expect(countCodesFor('avis')).toBeLessThan(rows);
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

  it('proposes nothing for Enterprise, whose search cannot be reached', () => {
    // Enterprise is still `searchable: false` — its site ignores the query
    // string and its driver cannot set the trip's dates yet.
    //
    // "Nothing" means no *Enterprise* candidate, not an empty list. Asking for
    // Enterprise now returns National ones, because `wanted` is widened by
    // `alsoTryAs` before the search: a contract id filed under Enterprise is
    // worth trying at National, and National can be reached. That is the
    // intended behaviour rather than a leak — the codes are the same codes, and
    // nothing is routed to the vendor that cannot run them.
    const candidates = buildCandidates({ vendors: ['enterprise'] });
    expect(candidates.some((c) => c.vendor === 'enterprise')).toBe(false);
  });

  it('races an Enterprise contract id at National, which can be reached', () => {
    // The `alsoTryAs` fan-out, awake again now that National has a driver. This
    // is the only route by which National gets any codes at all: the workbook
    // files every one of them under Enterprise, and there is not a single
    // record with `vendor: 'national'`.
    const candidates = buildCandidates({ vendors: ['national'] });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.vendor === 'national')).toBe(true);
    // IBM's, the one the driver was proved against on the live site.
    expect(candidates.map((c) => c.code)).toContain('5666666');
    expect(getVendor('enterprise').alsoTryAs).toEqual(['national']);
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
    // Four, and the number is derived rather than chosen. It was five while
    // Sixt shipped with three codes: the other two lanes had to absorb the
    // remaining nine, so one of them legitimately reached five of twelve. Sixt
    // is `searchable: false` now and every remaining car vendor has at least
    // nineteen codes, so a fair spread over twelve slots is exactly four — and
    // leaving the bound at five would quietly tolerate a {5,4,3} split it was
    // never meant to allow.
    expect(Math.max(...perVendor.values())).toBeLessThanOrEqual(4);
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
