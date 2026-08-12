import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { vendorHosts } from '../src/core/vendors.js';

interface Manifest {
  manifest_version: number;
  version: string;
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[]; run_at?: string }>;
  background: { service_worker: string; type: string };
  action: { default_popup: string };
  web_accessible_resources?: unknown;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
) as Manifest;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

const expected = vendorHosts().map((host) => `https://${host}/*`);

describe('manifest.json', () => {
  it('is MV3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('carries the same version as package.json', () => {
    // The manifest's version is the one Chrome shows on the extensions page,
    // so it is what tells you a reload actually picked up your build. The two
    // drifting would make that check quietly meaningless — you would read
    // package.json's number in the diff and Chrome would show the other.
    expect(manifest.version).toBe(pkg.version);
  });

  it('uses a plain three-part version Chrome will accept', () => {
    // Chrome requires one to four dot-separated integers, each 0-65535, and
    // refuses to load the extension otherwise — a suffix like `-rc1` or
    // `0.1.1+build` is a hard failure at load time, not a warning.
    expect(manifest.version).toMatch(/^\d{1,5}(\.\d{1,5}){0,3}$/);
  });

  it('requests exactly the hosts the vendor registry needs', () => {
    // Adding a vendor to vendors.ts without granting its host would leave the
    // content script silently uninjected, so the two are pinned together.
    expect([...manifest.host_permissions].sort()).toEqual(expected);
  });

  it('injects the probe on those same hosts, and nowhere else', () => {
    // Every entry is enumerated rather than just the first, so a second one
    // cannot smuggle in extra match patterns unnoticed.
    expect(manifest.content_scripts).toHaveLength(2);
    const probe = manifest.content_scripts[0];
    expect(probe).toBeDefined();
    expect([...probe!.matches].sort()).toEqual(expected);
    expect(probe!.js).toEqual(['content.js']);
    // The probe needs the DOM, so it must not move earlier.
    expect(probe!.run_at).toBe('document_idle');
  });

  it('resets the stale widget state only on Avis, and only before the page reads it', () => {
    // Narrower than the probe on purpose: `booking-widget.store` is one
    // vendor's implementation detail, and clearing storage on a site that does
    // not need it would be an unasked-for side effect on the user's browsing.
    //
    // `document_start` is the whole point rather than a preference. Avis reads
    // that store while hydrating, and it takes precedence over the query
    // string — a profile that had searched Philadelphia by hand rendered
    // "Tampa Intl Airport (TPA) - Philadelphia Intl Airport (PHL)" for a URL
    // asking TPA to TPA. At `document_idle` the clear happens long after the
    // page has already made that decision, so this entry is worthless the
    // moment its timing changes.
    const reset = manifest.content_scripts[1];
    expect(reset).toBeDefined();
    expect(reset!.matches).toEqual(['https://www.avis.com/*']);
    expect(reset!.js).toEqual(['reset-widget-state.js']);
    expect(reset!.run_at).toBe('document_start');
  });

  it('asks for storage and nothing else', () => {
    // "tabs" is what makes Chrome say "Read your browsing history" at install,
    // and it grants the URL and title of every tab the user has open. Nothing
    // here needs it: tabs.create/remove/onRemoved work without it and the only
    // property ever read off a tab is its id. Pinned so it cannot creep back.
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('exposes no extension resource to vendor pages', () => {
    // web_accessible_resources would make the extension id fingerprintable by
    // every site the content script runs on.
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('points at the files the build actually emits', () => {
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
    expect(manifest.action.default_popup).toBe('src/popup/index.html');
  });
});
