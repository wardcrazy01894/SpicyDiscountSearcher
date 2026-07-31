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
tabs before cancelling the first.

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

`probe-timeout` is the exception, because by definition the probe said nothing.
The background reads the tab itself just before closing it and builds a report
with `path: 'not-reached'` — same path-only rule. Without it the commonest
failure was the one with no evidence at all, and "Hertz always times out" could
not be told apart from a consent interstitial or a country picker.

It cannot always read it. The manifest holds no `tabs` permission — PR #5
dropped it deliberately — so Chrome omits `url` and `title` for a tab whose
current URL is not one of the nine vendor hosts. Not a gap to paper over with a
permission, but not a diagnosis either: all it establishes is that the tab's
address is unreadable, which is equally true of a redirect off the vendor's
site and of a load that never committed (`about:blank`, or `chrome-error://`
after a DNS or TLS failure). Both also mean the content script never ran, so
both cause timeouts. `path: 'left-our-origins'` records the fact and the popup
names both possibilities; claiming either one would repeat the mistake this
replaced, which was asserting the other. The chrome fake models the permission
rule, having previously returned `url` unconditionally and hidden it.

`not-reached` and `left-our-origins` are the background's own knowledge, so a
content script may not claim either — `PROBE_PATHS` enforces that at ingest,
exactly as `PROBE_FAILURES` does for failure codes. A forged branch is
downgraded rather than dropped: the landed path, title and count are still the
probe's own observations and worth keeping; only the claim about who made them
is refused.

`Quote.lateReport` is evidence that arrived _after_ the quote was settled. A
page can begin its final extract a millisecond inside the deadline and send
after it; that reply used to be discarded whole while the quote kept a
`probe-timeout` saying nothing came back. The late payload can attach a report
and nothing else — it never settles a quote, changes a verdict or contributes a
price, because a page that missed its deadline must not win a race the user
already saw finish. `ActiveRun.retiredTabs` is what makes that possible, and is
deliberately a second map rather than a delayed delete from `tabs`.

A content script may only claim `extract-threw` or `probe-empty`. Anything else
is the background's own knowledge, and a page claiming `cancelled` would
misattribute its failure to the user.

`warn()` in the service worker is the only place this extension logs. There is
no log store and the worker's console dies with it, so the structured fields
above remain the real telemetry — `warn` is the backstop for failures that
belong to no quote (a storage write that failed, a tab or window that would not
close). Never pass it a URL or a code.

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
- Three Hilton codes sit under a company called `Unattributed`, because the
  workbook cell beside them really was a qualifier rather than an employer.
  That is now the only reason anything lands there.

  It used to be nine, and the other six were a parser bug rather than a
  spreadsheet one: `parse_hilton_sheet` consumed leading code-shaped tokens
  with `looks_like_code`'s letters-only branch **on**, so it ate the first
  words of the employer's own name. `FIAT` came off row 56, `LET`/`ME`/`ADD`
  off the front of a sentence. Every code on that sheet carries a digit, so the
  branch is now off for that caller, and no Hilton-sheet code is letters-only
  any more. `MH` (company `Explore More`) is the only letters-only **hilton**
  code left, and it comes from a grid sheet, where letters-only codes are
  legitimate — there are around a hundred of them across the other vendors
  (`ACC`, `DTC`, `MMM`), all untouched.

  Same fix recovered thirty employers. Most had been published under a fragment
  of their name — `Bank of America` as `America`, and `Koch Industries` and
  `Shaw Industries` both as `Industries`, _merged_ into a single six-code
  company belonging to neither. `BP`, `Dell` and `UPS` were dropped whole: their
  names are entirely code-shaped, so the loop consumed the row and left nothing
  to be the company. Those three come back from the letters-only rule alone,
  since none of them carries a digit.

  `3M` is the one that needed more, and it is the example in the function's own
  docstring. It carries a digit, so the loop still ate it; the loop therefore
  never consumes the last token, because every row on this sheet ends with the
  employer. A row that is genuinely nothing but codes is reported rather than
  published with an account number as its company name — tested against the
  account-number shape rather than `looks_like_code`, since every real employer
  here (`3M`, `BP`, `UTC`) passes the latter.

  `Benjamin Moore` (row 24, `à / 560002892 Benjamin Moore and Company`) is back
  too — a single stray character ahead of the codes is skipped as decoration.

- Every `continue` in `extract_codes.py` used to drop a row in silence while
  the summary counted only what it kept, which is how `Benjamin Moore` stayed
  lost. Skipped rows now print to stderr and the `data` job shows them.

  Five rows are skipped today and **nothing is lost to any of them**. One is a
  margin note. The other four have a URL where the employer's name should be:
  three have no codes beside them at all, and the fourth (`Marriott Codes`
  row 74) is a duplicate of `Codes` row 74, whose code `17885` already ships
  under `Harvard`. `Marriott Codes` is largely a copy of `Codes` with a link
  pasted over one name cell.

  The reporting exists for the row that is _not_ a duplicate. Until it printed
  them, a URL row that carried the only copy of a code would have vanished
  exactly the way `Benjamin Moore` did, and the summary would still have looked
  healthy.
