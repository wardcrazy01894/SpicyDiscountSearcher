import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { vendorHosts } from '../src/core/vendors.js';

interface Manifest {
  manifest_version: number;
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
  background: { service_worker: string; type: string };
  action: { default_popup: string };
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

  it('injects the content script on those same hosts', () => {
    const script = manifest.content_scripts[0];
    expect(script).toBeDefined();
    expect([...script!.matches].sort()).toEqual(expected);
    expect(script!.js).toEqual(['content.js']);
  });

  it('points at the files the build actually emits', () => {
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
    expect(manifest.action.default_popup).toBe('src/popup/index.html');
  });
});
