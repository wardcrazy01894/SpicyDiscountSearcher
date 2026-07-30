import { describe, expect, it } from 'vitest';

import {
  allCompanies,
  buildCandidates,
  codeDatabase,
  companyBySlug,
  countCodesFor,
  searchCompanies,
} from '../src/core/codes.js';
import { VENDORS } from '../src/core/vendors.js';

const VENDOR_IDS = new Set(VENDORS.map((v) => v.id));

describe('the generated code database', () => {
  it('parsed a substantial number of companies and codes', () => {
    // A regression in extract_codes.py that quietly drops rows would show up
    // here before it ships as an extension that finds nothing.
    const companies = allCompanies();
    expect(companies.length).toBeGreaterThan(150);
    const codes = companies.flatMap((c) => c.codes);
    expect(codes.length).toBeGreaterThan(400);
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
