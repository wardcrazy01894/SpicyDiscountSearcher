# Spicy Discount Searcher — working notes

MV3 browser extension (Chrome/Brave) that races corporate discount codes to find
the cheapest rental car or hotel rate. Read `README.md` first — this file only
covers things that aren't obvious from the code.

## Ground rules

- **`src/data/codes.generated.json` is generated.** Never hand-edit it. Change
  `scripts/extract_codes.py` or the workbook and re-run `npm run codes`. CI
  fails the `data` job if the committed JSON doesn't match a fresh run.
- **`src/core/vendors.ts` is the source of truth for hosts.** Adding a vendor
  means adding it there, then updating `public/manifest.json` — `tests/manifest.test.ts`
  pins the two together and will fail if you forget.
- **Two vite builds, on purpose.** MV3 content scripts aren't ES modules, so
  `vite.content.config.ts` bundles `src/content/probe.ts` as a single IIFE with
  `emptyOutDir: false`. Run order matters; `npm run build` handles it.
- The extension root is `dist/`, so absolute asset paths in the built popup
  (`/popup.js`) resolve correctly. That's expected, not a bug.

## What's fragile and why

`src/core/deeplinks.ts` and the `VENDOR_SELECTORS` map in `src/core/extract.ts`
encode other people's websites. They will break. Both are deliberately isolated:

- Deep links are one function per vendor with a `confidence` flag. Everything
  else calls `buildDeepLink` and doesn't care.
- Extraction tries per-vendor CSS first and falls back to a generic currency
  sweep, so a redesign degrades to "still finds prices, loses the class labels"
  rather than returning nothing.

When fixing either, add or update the matching test — the point of the tests is
to make a change deliberate, not to prove the vendor still works.

## Comparison correctness

The two things that would silently produce a wrong answer, and their guards:

- **Mixed price bases.** `Offer.basis` tags each number `total` / `per-day` /
  `unknown`, and `bestOffer` prefers totals. Never rank across bases.
- **Different car classes.** A code showing an Economy when others show Midsize
  looks cheapest but isn't comparable. `classMatrix` finds classes the codes
  have in common; the popup warns when the headline winner doesn't win there.

## Politeness

Concurrency is capped at 6 (default 2) with a 750 ms stagger, tabs open in a
minimised window and close as soon as they answer, and the content script stays
inert unless the background assigns it a quote. Keep it that way — this opens
real tabs on real vendor sites.

## Known gaps

- Deep-link query params are unverified against live sites (see README).
- MV3 can terminate the service worker mid-run; finished quotes survive in
  `chrome.storage.session` but an in-flight run may not.
- Hotel support is wired end to end but has had far less thought than cars.
- No end-to-end test that actually loads the extension in a browser.
