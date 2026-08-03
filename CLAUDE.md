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
- **A number that was never a rate.** "Total taxes and fees: $57.20" carries the
  word `total`, so it was tagged `total` — the most trusted basis — and being
  the cheapest number there it became the page's headline price. Bucketing
  cannot save you from this: the number really is in the reported bucket.
  `isFeeLine` in `extract.ts` strips the fee phrases and asks what is left; if
  something still says what the number means (`total`, `/day`) the fee words
  were a modifier and the number is a price. A fee element stays a _site_ so it
  claims its number away from the card, and the flag propagates to any site
  inside it — a `<span>` around the amount defeated the first version entirely.

  Known escapes, all of which also escape on `main`: a flat label/amount sibling
  pair directly under the card with no wrapper element, and `Taxes and fees not
included: $57.20`, where the negation is invisible to the rule. Both surface a
  fee as a price.

- **A digit in a model name.** `PRICE_RE`'s suffix branch is
  `(NUMBER)\s*(CURRENCY)`, and car pages are full of names ending in digits. The
  `5` of `Audi Q5` matched against the `$` of the price that followed it and
  **consumed the dollar sign**, so the real amount had no currency left to pair
  with: `2023 Audi Q5 $95.00 per day` read as `5 USD`, and
  `Cadillac XT5 $150.00 total` as `5 USD` in the most-trusted basis there is. A
  $5 total beats every genuine rate anywhere in the race.

  This is the same phantom the `CURRENCY_CODE` letter-lookaround closed (`AUD`
  inside `Audi`), arriving through the symbol branch instead. Two lookbehinds on
  the suffix branch's number close it, and the first must exclude **digits** as
  well as letters: blocking only the first position of `150` let the engine
  start one character along at `50`, so `Ford F-150 $89.00` returned `50 USD` —
  a number printed nowhere on the page, and cheaper than the one it displaced. A
  guard that refuses only the first position of a digit run refuses nothing.

  Known escapes here: `Seats 5 $45.00` still reads `5`, because blocking a bare
  count before a symbol price means rejecting `$` after a number, and fr-CA
  writes `45 $`. And `Class C$120.00` in a single text node reads 120 **CAD**,
  since `C$` and `A$` are real currency symbols and `Class C` / `Group A` are
  real car classes — nothing in the string distinguishes them. Realistic markup
  escapes the second: `offerText` puts a boundary space between elements, so
  `<span>Class C</span><span>$120.00</span>` parses correctly. Both are pinned
  by tests so a later change to `PRICE_RE` is deliberate.

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

A cancel can also arrive while a lane is _between_ its two `run.cancelled`
checks. `runQuote` tests the flag, then `await publish()`, then calls
`ensureWindow` — and a lane parked on that publish resumes to find
`windowPromise` nulled by `closeWindow` and memoises a **second** window, after
the run was cancelled and its first window closed. Nothing in that worker closes
it: the run is torn down and `reapOrphanWindow` only runs at startup.
`ensureWindow` therefore refuses outright when `run.cancelled` is set, so the
memoised promise cannot be re-armed after teardown.

There is deliberately **no** second check after `chrome.windows.create` resolves,
though one was written first. A cancel landing while Chrome is still opening the
window does get past the guard — but assigning `run.windowId` is what makes that
window findable, and `startRun`'s own teardown closes it on the way out.
Throwing there instead left `windowId` null and orphaned the window for good,
which is the bug the guard was supposed to fix. Both directions are pinned by
tests, and the tests only work because the chrome fake can delay a session write
and a `windows.create`: with everything resolving instantly no lane is ever in
the gap, and the first three attempts at this test passed with the guard
deleted.

Two `START_RUN`s can also arrive without any retry, because the popup only
disabled Run when the reply came back: a double-click sent two. `cancelRun()`
returns immediately when `active` is null, so both passed it and both built a
run — two minimised windows, twice the cap, twice the load on every vendor, and
the first window orphaned permanently because `runWindow` had been overwritten.

Guarded on both sides now. In the worker, `startingRun` holds the in-flight
promise and a concurrent call awaits it, so both callers get the same run — read
and assigned with no `await` between, since an async guard is not a guard, which
is exactly how `cancelRun()` failed at this. Sharing rather than refusing
matters because `active` is never nulled: after an earlier run has finished it
still points at that one, so a refused caller was answered with a state carrying
`finishedAt` — which the popup reads as "no run in progress" and re-arms the
button on, defeating the guard it had just passed. The second caller also
silently loses its own plan and receives the first one's; the popup cannot send
two different plans today, but nothing enforces that.

In the popup, `ui.pendingStart` is set synchronously on submit and cleared when
a reply renders. Without it `runBtn.disabled` was re-armed by the next
`refreshPlan` — a max-codes keystroke, a vendor chip, a company checkbox — since
`ui.running` only becomes true once the background answers. That window is
exactly where a double-click's second message went, and it is why "the button
stays disabled after a failed send" was false until this flag existed.

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
after a DNS or TLS failure). Both also mean the content script **is no longer
running**, so both cause timeouts — not that it never ran, which is only true of
the second. A redirect that happens after the vendor's page has loaded runs the
script and then tears it down mid-probe, and the symptom is identical.
`path: 'left-our-origins'` records the fact and the popup names both
possibilities; claiming either one would repeat the mistake this replaced, which
was asserting the other. A redirect to a sibling host of the same brand
(`www.hertz.co.uk`, or a bare `hertz.com`) lands here too, where neither "off
the vendor's site" nor "never got there" is quite right — the line leads with
the unreadable-address fact for that reason. The chrome fake models the
permission rule, having previously returned `url` unconditionally and hidden it.

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
- MV3 can terminate the service worker mid-run, and did so on **any run
  containing a page that does not price**: the probe is silent until prices
  settle or its 45s deadline passes, which is longer than Chrome's ~30s idle
  limit. Not on _every_ run — `PROBE_READY` and each settled quote reset the
  countdown, so a race where both pages price in seconds never tripped it.
  `KEEPALIVE_MS` now pokes an extension API every 20s for the life of a run.

  The recovery paths remain and still matter, because a keepalive is a
  mitigation rather than a guarantee — Chrome can still reclaim a worker under
  memory pressure. `GET_STATE` settles a stale snapshot instead of leaving it
  looking live forever, a restarted worker closes the window its predecessor
  orphaned, and the in-flight quotes are still lost when it happens.

  `KEEPALIVE_CEILING_MS` stops it after ten minutes regardless. MV3 suspension
  used to be the backstop for a wedged run — `runQuote` awaits `ensureWindow`
  and `chrome.tabs.create` with no timeout around either, so a lane parked on a
  `windows.create` that never settles ended when Chrome reclaimed the worker.
  Pinning the worker removed that, and would otherwise hold a minimised window
  open indefinitely while the popup looks idle.

  The tests assert the **gap** between pokes, not a count, and the difference is
  the whole mechanism. A count-based version passed while `setTimeout` stood in
  for `setInterval` — a keepalive firing once at 20s and never again, which
  reproduces the original bug exactly. Deleting a guard is the weak mutation
  here; these are the ones that matter, and all four were checked to fail:
  no `startKeepAlive`, no `stopKeepAlive`, one-shot instead of repeating, and
  `KEEPALIVE_MS = 29_500` — which leaves no margin for a delayed tick and which
  a "under 30s" assertion would have waved through.

- Hotel support is wired end to end but has had far less thought than cars.
- No end-to-end test that actually loads the extension in a browser.
- Most of `src/popup/popup.ts`'s _logic_ is still unpinned — the comparison
  warnings, the plan line's wording, saved-selection persistence. Its
  import-time contract is not: `tests/popup-contract.test.ts` loads the real
  `index.html` into jsdom and imports the module, so a renamed id fails the
  suite. It used to fail nothing, while bricking the popup.

  Neither is the popup half of the double-run guard, which the Politeness
  section above asserts as a checkable invariant. It is driven through the real
  button rather than a synthetic `submit` event, because the guard works by
  disabling that button and a synthetic submit walks straight past the thing
  under test. Both directions are covered: `ui.pendingStart` must survive a
  `refreshPlan` mid-flight, and must be cleared when the background answers —
  latched, it disables Run for the life of the popup.

  Same for the failed-send state. A rejected `START_RUN` does not prove
  non-delivery, so `ui.sendFailed` keeps Run disabled _and_ keeps the reason on
  screen through the `refreshPlan` triggers that used to wipe it. It is cleared
  by a `RUN_STATE` broadcast, because a broadcast is proof the message did
  arrive — without that the popup sits telling the user to reopen it while the
  race it started runs behind it.

- TypeScript is pinned below 7 by something outside this repo.
  `typescript-eslint@8.65.0` is the newest release — its canary too — and
  declares `peer typescript ">=4.8.4 <6.1.0"`, so `npm ci` cannot resolve TS 7
  at all. The code itself is ready — measured on Dependabot's branch with
  `--legacy-peer-deps`, `tsc --noEmit` is clean under 7.0.2 and the suite
  passes — so this is a wait, not a migration. `.github/dependabot.yml` ignores
  `typescript` 7.x so the same unmergeable PR does not arrive monthly; the entry
  says to remove it when typescript-eslint's peer range moves, and that library's
  own major bump is the cue.

  The stable 6.x that did not exist when that was written now does, and we are
  on it: `typescript@6.0.3` installs under a plain `npm ci`, needing no
  `--legacy-peer-deps`, which is the whole difference from the 7.x attempt. It
  is inside the peer range rather than in spite of it, so nothing about the
  blocker above changed — 7 is still unresolvable for the same reason.

  Note the range's upper bound is `<6.1.0`, not `<7`. TypeScript 6.1 will be as
  unresolvable as 7 is, and it is not covered by the `7.x` ignore, so it would
  arrive as exactly the recurring red PR that entry exists to prevent. Left
  uncovered on purpose: typescript-eslint widening its peer range is the more
  likely of the two to land first, and pre-emptively ignoring `6.1.x` would
  suppress a bump that had become perfectly installable.

- `buildCandidates` calls the throwing `getVendor` on ids from the generated
  JSON, so removing a vendor from `vendors.ts` without regenerating would kill
  the popup in `refreshPlan`. Not actually reachable: `tests/codes.test.ts`
  asserts every id in the JSON is known, and `test` is a required check, so it
  goes red before it can go out. Listed here because the _code_ has no guard of
  its own.
- Three Hilton codes sit under a company called `Unattributed`, because the
  workbook cell beside them really was a qualifier or a note rather than an
  employer.
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

  Six rows are skipped today and **nothing is lost to any of them**. One is a
  margin note. Four have a URL where the employer's name should be: three have
  nothing beside them at all, and the fourth (`Marriott Codes` row 74) is a
  duplicate of `Codes` row 74, whose code `17885` already ships under `Harvard`.
  `Marriott Codes` is largely a copy of `Codes` with a link pasted over one name
  cell — but not redundant: 13 published codes have `Marriott Codes` as their
  only source and 8 have `Codes` as theirs, so dropping either loses data.

  The sixth is `Marriott Codes` row 78, which has no name cell at all and a
  booking link in a data cell. It was the last `continue` still dropping a row
  in silence: "nameless" is not the same as "empty", and this branch could not
  tell them apart. It now reports a nameless row **only** when the row still
  carries a code or a link, so the blank padding below the data stays quiet.

  The skip message counts links as well as codes for the same reason. A row
  whose only payload is a booking URL used to report `0 code(s) beside it` —
  true, and read by anyone as "nothing was lost".

  None of this reporting exists for the six. It exists for the row that is not a
  duplicate, which the workbook does not contain today and may tomorrow: until
  these printed, a row carrying the only copy of a code would have vanished
  exactly the way `Benjamin Moore` did, and the summary would still have looked
  healthy.
