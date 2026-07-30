import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { vendorHosts } from '../src/core/vendors.js';

interface Manifest {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
  background: { service_worker: string; type: string };
  action: { default_popup: string };
  web_accessible_resources?: unknown;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
) as Manifest;

const expected = vendorHosts().map((host) => `https://${host}/*`);

describe('manifest.json', () => {
  it('is MV3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests exactly the hosts the vendor registry needs', () => {
    // Adding a vendor to vendors.ts without granting its host would leave the
    // content script silently uninjected, so the two are pinned together.
    expect([...manifest.host_permissions].sort()).toEqual(expected);
  });

  it('injects the content script on those same hosts, and nowhere else', () => {
    // Asserting only content_scripts[0] would let a second entry smuggle in
    // extra match patterns unnoticed.
    expect(manifest.content_scripts).toHaveLength(1);
    const script = manifest.content_scripts[0];
    expect(script).toBeDefined();
    expect([...script!.matches].sort()).toEqual(expected);
    expect(script!.js).toEqual(['content.js']);
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
