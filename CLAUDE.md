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
  `scripts/check-dist.mjs` parses the built content script as a _classic_
  script and fails the build if it isn't one, because nothing else does — no
  test imports from `dist/`. That check exists because vite 8 swapped Rollup
  for Rolldown underneath us and quietly dropped `"use strict"`; the bundler
  can change again, so the config pins `output.strict`.
- The extension root is `dist/`, so absolute asset paths in the built popup
  (`/popup.js`) resolve correctly. That's expected, not a bug.

## What's fragile and why

`src/core/deeplinks.ts` and the `VENDOR_SELECTORS` map in `src/core/extract.ts`
encode other people's websites. They will break. Both are deliberately isolated:

- Deep links are one function per vendor with a `confidence` flag, which rides
  on the `Quote` and shows in the popup. Everything else calls `buildDeepLink`
  and doesn't care. Every builder is `'best-effort'` today, so the popup says so
  once for the whole list rather than badging every row.
- Extraction supports per-vendor CSS and falls back to a generic currency sweep.
  All nine vendors define a `container` selector, and those do run — they scope
  the sweep away from nav and footer. **No vendor defines an `offer` selector**,
  though, so the per-offer branch never fires and every `ProbeReport` says
  `generic-sweep`. The selector path is kept — and tested with an injected
  config — so it works the day someone fills one in.
- A vendor redesign therefore degrades to a noisier sweep rather than nothing.
  Labels are best-effort: a card with no heading of its own inherits the
  previous card's, which markup cannot distinguish from a legitimate wrapper.

When fixing either, add or update the matching test — the point of the tests is
to make a change deliberate, not to prove the vendor still works.

## Comparison correctness

The two things that would silently produce a wrong answer, and their guards:

- **Mixed price bases and currencies.** `Offer.basis` tags each number `total` /
  `per-day` / `unknown`. `bestOffer` prefers totals _within_ one page;
  `comparisonGroups` in `compare.ts` buckets quotes by basis **and** currency so
  nothing is ranked across either. Quotes outside the reported bucket are listed
  but explicitly not ranked, and the popup says so — otherwise they read as
  having simply lost. A per-day quote also shows an estimated trip total,
  labelled an estimate, and that estimate never feeds ranking.
- **Different car classes.** A code showing an Economy when others show Midsize
  looks cheapest but isn't comparable. `classMatrix` finds classes the codes
  have in common — restricted to the reported bucket, since a matrix mixing a
  daily rate with a trip total checks nothing. The popup warns when the winner
  doesn't win there, _and_ when the codes share no class at all, which is the
  weakest evidence there is and used to pass in silence.
- **A link that missed its search.** A vendor home page still shows
  "from $19/day", so the quote comes back `ok` and, being cheapest, wins. The
  probe reports its landed path; a quote that landed on the site root is flagged
  in the popup. Structurally blind for Avis and Budget, whose deep links target
  `/en/home` already.

## Politeness

Concurrency is capped at 6 (default 2), tabs open in a minimised, unfocused
window and close as soon as they answer, and the content script stays inert
unless the background assigns it a quote. Keep it that way — this opens real
tabs on real vendor sites.

The 750 ms stagger is **between a lane's consecutive quotes**, not between
concurrent tab opens: at run start every lane opens a tab at once. All four of
these are pinned by tests in `tests/service-worker.test.ts` that fail if the
window becomes visible, the tabs become active, the stagger goes to zero, or the
cap is lifted — they were unpinned until someone checked.

`START_RUN` is deliberately not retried on a failed `sendMessage`: a rejection
doesn't prove non-delivery, and a retry starts a second race that opens real
tabs before cancelling the first. For the same reason the Run button stays
disabled after a failed send — reopening the popup is the recovery, and it
re-arms correctly from `GET_STATE`.

Two `START_RUN`s can also arrive without any retry, because the popup only
disabled Run when the reply came back: a double-click sent two. `cancelRun()`
returns immediately when `active` is null, so both passed it and both built a
run — two minimised windows, twice the cap, twice the load on every vendor, and
the first window orphaned permanently because `runWindow` had been overwritten.
Guarded on both sides now: `starting` in the worker (checked and set with no
`await` between, since an async guard is not a guard) and a synchronous
`disabled` in the popup. The second caller is answered with the run that _is_
starting rather than an error — one Run press, one race, which is what was
asked for.

## Diagnosing a run afterwards

`Quote.failure` is a code, not a sentence — `probe-timeout`, `probe-empty`,
`extract-threw`, `tab-closed`, `link-build`, `tab-open`, `interrupted`,
`cancelled`. The popup renders a short phrase per code and keeps the raw message
in a tooltip. Assert the **code** in tests; rewording a message must not change
what the system believes happened.

`Quote.report` carries what the probe actually saw — landed path, page title,
offer count, extraction branch — and renders under any failed or flagged quote.
Path only, never the query string: that carries the discount code and the user's
itinerary.

A content script may only claim `extract-threw` or `probe-empty`. Anything else
is the background's own knowledge, and a page claiming `cancelled` would
misattribute its failure to the user.

## Known gaps

- Deep-link query params are unverified against live sites (see README).
- MV3 can terminate the service worker mid-run. `GET_STATE` now settles such a
  snapshot instead of leaving it looking live forever, and a restarted worker
  closes the window its predecessor orphaned — but the in-flight quotes are
  still lost.
- Hotel support is wired end to end but has had far less thought than cars.
- No end-to-end test that actually loads the extension in a browser.
- No tests for `src/popup/popup.ts`: it runs `el()` lookups at import time, so
  testing it needs the real HTML in jsdom. Its logic is unpinned.
- `buildCandidates` calls the throwing `getVendor` on ids from the generated
  JSON. Remove a vendor from `vendors.ts` without regenerating and the popup
  dies in `refreshPlan`; the `data` job doesn't assert the ids are known.
- Nine Hilton codes sit under a company called `Unattributed`. Six are there
  because the workbook cell beside them really was a margin note. The other
  three are a worse story: row 56 reads `N0394181 / 0000394181 Fiat (Americas
only)` — an ordinary employer row — but `looks_like_code('FIAT')` is true, so
  the brand name was eaten as a third code and only the qualifier was left to be
  the company. **Fiat is not in the database at all**, and `FIAT` ships as a
  Hilton code.
- Same root cause, four times: `LET`, `ME` and `ADD` are English words taken off
  the front of `Let me add a few I've umulated for EMEA…`, and `FIAT` is a brand
  name. `looks_like_code`'s letters-only branch cannot tell any of them from a
  real code.
- Two real employers are lost outright. `Benjamin Moore` (row 24, `à / 560002892
Benjamin Moore and Company`) is dropped because the stray leading `à` isn't
  code-shaped, so the row collects no codes at all and is skipped. `Fiat` is
  lost as described above. Neither can be found by name in the picker.
