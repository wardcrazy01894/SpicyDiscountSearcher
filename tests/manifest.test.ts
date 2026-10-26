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
) as { version: string; engines?: { node?: string } };

const lock = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'),
) as { version: string; packages: Record<string, { version?: string }> };

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

  it('is the version the lockfile records too', () => {
    // Bumping the version every PR means the lockfile drifts every PR unless
    // it moves with them — and then any `npm install` silently rewrites it into
    // an unrelated diff. Both of the lockfile's self-references, not its
    // dependencies.
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
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

describe('package.json', () => {
  it('keeps @types/node on the lowest Node major this repo runs on', () => {
    // What tsc accepts is decided by the installed @types/node major, and the
    // runtime it must not exceed is the lowest Node that CI actually runs: a
    // Node-26-only API typed in would pass typecheck and fail at runtime on
    // the 22 leg, with nothing saying why. Dependabot is told the same in
    // dependabot.yml; this is the half that catches a hand-run
    // `npm i -D @types/node@latest`, an engines bump that forgot the typings,
    // or a workflow that forgot the engines.
    //
    // Every reading is the lowest major rather than the first written —
    // `engines` can list its clauses in any order — and the typings come from
    // the lockfile's resolved version, which is what is installed, not from a
    // range that `>=22` would satisfy at 26.
    //
    // ci.yml is read in exactly the two spellings this repo uses — a quoted
    // flow list `node: ['22', '24', '26']` for the matrix and a quoted
    // `node-version: '22'` for a single job — and nothing else. A block
    // sequence, `lts/*`, `v22` or a bare number is not tolerated and quietly
    // read as fewer legs; it is a failed assertion that names the file, so a
    // reformat of the workflow turns this test red instead of hollow.
    const major = (version: string) => Number(/^(\d+)\.\d+\.\d+/.exec(version)?.[1] ?? NaN);
    const engines = pkg.engines?.node ?? '';
    const engineMajors = engines
      .split('||')
      .map((clause) => major(clause.replace(/^[\s^~>=<]+/, '')))
      .filter((n) => Number.isFinite(n));
    expect(engineMajors.length, `engines.node unreadable: ${engines}`).toBeGreaterThan(0);
    const engineFloor = Math.min(...engineMajors);

    const ci = readFileSync(
      fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    const matrices = [...ci.matchAll(/^\s*node:\s*\[((?:\s*'\d+'\s*,?)+)\]\s*$/gm)];
    expect(matrices.length, 'ci.yml has no quoted flow-list node matrix').toBe(1);
    const matrixLegs = [...(matrices[0]?.[1] ?? '').matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
    const singleLegs = [...ci.matchAll(/^\s*node-version:\s*'(\d+)'\s*$/gm)].map((m) =>
      Number(m[1]),
    );
    expect(singleLegs.length, 'ci.yml has no quoted single node-version').toBeGreaterThan(0);
    const legs = [...matrixLegs, ...singleLegs];

    const installed = lock.packages['node_modules/@types/node']?.version;
    expect(installed, '@types/node is not in the lockfile').toBeDefined();

    expect(Math.min(...legs), 'the lowest Node CI runs is not the engines floor').toBe(engineFloor);
    expect(major(installed ?? ''), 'the installed @types/node major').toBe(engineFloor);
  });
});
