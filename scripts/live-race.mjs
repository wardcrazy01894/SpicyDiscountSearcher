#!/usr/bin/env node
/**
 * Run a real race from a loaded build, and print what came back.
 *
 * This is the live test CLAUDE.md keeps asking for: not a foreground tab with
 * devtools open, but the extension's own service worker opening its own
 * minimised window and its own probe tab, driving the vendor's form and
 * extracting the page — exactly the race the popup would run. It launches a
 * Chromium-based browser with `dist/` loaded, opens the popup as a page, fills
 * the trip, ticks the vendors and the company, clicks Run, and polls the
 * results until the run finishes. The run state, with every quote's
 * `report`, lands in `<out>/state.json`.
 *
 * Needs `npm run build` first, and a browser that still honours
 * `--load-extension`: **branded Google Chrome dropped it in 137**, so point
 * this at Brave or Chromium. The profile is a throwaway, which means a vendor
 * whose bot check the user's own profile has passed may raise it again here.
 *
 *   node scripts/live-race.mjs \
 *     --browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
 *     --company IBM --vendors enterprise --max 1 \
 *     --pickup TPA --from 2026-11-10T09:00 --to 2026-11-13T17:00
 *
 * `--vendors` is a regex matched against the chip labels; `--out` and
 * `--profile` default to directories under the system temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, i, all) => (arg.startsWith('--') ? [arg.slice(2), all[i + 1] ?? ''] : null))
    .filter(Boolean),
);
const required = (name) => {
  const value = args[name];
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
};

const browserBin = required('browser');
const company = required('company');
const vendors = args['vendors'] ?? 'enterprise';
const maxCodes = args['max'] ?? '1';
const pickup = args['pickup'] ?? 'TPA';
const stamp = (name, fallback) => {
  const value = args[name] ?? fallback;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!match) {
    console.error(`--${name} wants yyyy-mm-ddThh:mm, got ${value}`);
    process.exit(2);
  }
  return [match[1], match[2]];
};
const [fromDate, fromTime] = stamp('from', '2026-11-10T09:00');
const [toDate, toTime] = stamp('to', '2026-11-13T17:00');
const ext = path.resolve(args['dist'] ?? 'dist');
const startedAtLabel = new Date().toISOString().replace(/[:.]/g, '-');
const out = args['out'] ?? path.join(os.tmpdir(), `spicy-live-race-${startedAtLabel}`);
const profile = args['profile'] ?? path.join(os.tmpdir(), 'spicy-live-race-profile');
fs.mkdirSync(out, { recursive: true });

const log = (...parts) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'run.log'), `${line}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: browserBin,
  headless: false,
  userDataDir: profile,
  defaultViewport: null,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,900',
  ],
});
browser.on('targetcreated', (t) => log('target+', t.type(), t.url().slice(0, 90)));
browser.on('targetdestroyed', (t) => log('target-', t.type(), t.url().slice(0, 90)));

try {
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 20_000 },
  );
  const id = new URL(sw.url()).host;
  log('extension', id);
  const worker = await sw.worker();
  worker?.on('console', (m) => log('[worker]', m.type(), m.text()));

  const page = await browser.newPage();
  page.on('console', (m) => log('[popup]', m.type(), m.text()));
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await page.waitForSelector('#vendor-chips label.chip');
  await pause(800);

  const set = (selector, value) =>
    page.$eval(
      selector,
      (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      value,
    );
  await set('input[name="pickupLocation"]', pickup);
  await set('input[name="pickupDate"]', fromDate);
  await set('input[name="pickupTime"]', fromTime);
  await set('input[name="dropoffDate"]', toDate);
  await set('input[name="dropoffTime"]', toTime);
  await set('#max-codes', maxCodes);
  await set('#concurrency', args['concurrency'] ?? '1');

  await page.evaluate((pattern) => {
    for (const label of document.querySelectorAll('#vendor-chips label.chip')) {
      const box = label.querySelector('input');
      const want = new RegExp(pattern, 'i').test(label.textContent ?? '');
      if (box && box.checked !== want) box.click();
    }
  }, vendors);
  await page.type('#company-search', company);
  await pause(500);
  const row = await page.evaluate((name) => {
    const rows = [...document.querySelectorAll('#company-list label.company')];
    const match = rows.find((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(name),
    );
    if (!match) return null;
    const box = match.querySelector('input');
    if (box && !box.checked) box.click();
    return (match.textContent ?? '').replace(/\s+/g, ' ').trim();
  }, company);
  if (!row) throw new Error(`no company row starts with ${company}`);
  log('company:', row);
  await pause(500);
  log('plan:', await page.$eval('#plan-summary', (el) => el.innerText.replace(/\s+/g, ' ')));

  const started = Date.now();
  await page.click('#run-btn');
  log('run clicked');
  let last = '';
  for (;;) {
    await pause(5_000);
    const text = await page
      .$eval('#results', (el) => el.innerText.replace(/\s+/g, ' ').trim())
      .catch(() => '');
    // `null` is "could not read the button", not "finished": a popup that
    // errored or navigated must keep the poll going rather than closing the
    // browser on a race still in flight.
    const running = await page.$eval('#run-btn', (el) => el.disabled).catch(() => null);
    if (text !== last) {
      log('results:', text.slice(0, 800));
      last = text;
    }
    log(`t+${Math.round((Date.now() - started) / 1000)}s running=${String(running)}`);
    if (running === false && Date.now() - started > 8_000) break;
    if (Date.now() - started > 600_000) {
      log('gave up after ten minutes');
      break;
    }
  }
  await page.screenshot({ path: path.join(out, 'popup.png') });
  const state = await page.evaluate(() => chrome.storage.session.get(null));
  fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state, null, 2));
  for (const quote of state.runState?.quotes ?? []) {
    log(
      'quote',
      quote.id,
      quote.status,
      quote.failure ?? '',
      JSON.stringify(quote.best ?? null),
      JSON.stringify(quote.report ?? null),
    );
  }
  log('written', out);
} finally {
  await browser.close();
}
