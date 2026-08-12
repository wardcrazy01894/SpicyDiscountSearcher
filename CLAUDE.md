# Spicy Discount Searcher — working notes

MV3 browser extension (Chrome/Brave) that races corporate discount codes to find
the cheapest rental car or hotel rate. Read `README.md` first — this file only
covers things that aren't obvious from the code.

## Where the work actually is

**Hertz, Avis and National are done. Leave them alone.** They run and they
return real prices. The remaining rental-car work is **Budget and Enterprise** —
the two that cannot run at all. If someone asks what is left to do on cars, that
list is the answer, and it does not include re-measuring a container, tightening
an extraction rule or capping a lane on a vendor that works.

**Sixt used to be on that list and is now closed.** Investigated 2026-08-12: its
search URL works and replays, but no corporate-code field exists anywhere in its
funnel, so neither a deep link nor a driver can apply one of our codes. It is
not outstanding work and should not be picked up again without a Sixt business
account login. `src/core/deeplinks.ts` has the parameters and the full finding.

Changes to a working vendor are **reactive only**, triggered by a symptom
somebody actually saw: prices stopped coming back, or an obviously wrong number
reached the popup. "I measured it and the config claims something untrue" is not
a symptom.

That rule was bought expensively on 2026-08-11. **Two** PRs landed against the
working vendors, carrying three changes between them — #59 bundled a container
measurement with a filter-bound extraction guard, #60 added an Avis lane cap —
and they broke production: Hertz priced **every quote at $20,000** (a marketing
line, reachable only when the container misses and the sweep falls back to
`doc.body`) and Avis returned one price for every code. Both reverted in #62.

Neither was prompted by a user-visible problem. #59's case was that the config
claimed something untrue about the page. #60's was better on its face — it closed
an open question this very file had recorded — which is the more dangerous shape,
because a note phrased as an open question reads as an invitation. That is why
the Known-gaps entries below were reworded rather than left standing.

The measurements behind them were wrong for a reason worth repeating: **a
foreground browser tab is not the probe.** The probe runs at `document_idle`, in
a minimised unfocused window where `setTimeout` is throttled to roughly once a
second, in a profile that may never have cleared Avis's bot check. Selectors
that match nothing in a settled devtools tab are not selectors that match
nothing there. Before changing extraction, get the evidence from `Quote.report`
— landed path, title, offer count, extraction branch — out of a real run. If the
fact you need is not in that report, add it to the report and change nothing
else.

## Ground rules

- **Run `npm run verify` before opening a PR.** It is the whole node side of CI
  in one command — typecheck, eslint, `prettier --check`, vitest, **all three**
  builds, `check-dist`, and `npm audit --audit-level=moderate`. Added on
  2026-08-12 because PR #65 failed the
  `build / typecheck / lint` job **twice** on things a local run would have
  caught in seconds: the author ran `vitest` and `tsc` by hand and simply did
  not think of `prettier`, which then failed on a markdown table whose padding
  no longer lined up. Picking the checks by hand is the bug; the point of one
  command is that there is nothing to pick.

  It does **not** cover the `data` job, which is Python — so **the pre-PR hook
  cannot see a Python mistake at all**. That is not hypothetical: adding
  `scripts/round-icon-corners.py` passed `verify`, passed the gate, and turned
  the `data` job red on a ruff rule. If you add or touch any `.py` file, or the
  workbook, run these yourself:

  ```bash
  uvx ruff@0.14.2 check scripts tests
  uvx ruff@0.14.2 format --check scripts tests
  python3 -m pytest tests -q
  npm run codes && git diff --exit-code -- src/data/codes.generated.json
  ```

  `uvx` rather than `pipx`, which this file said for months and which is not
  installed here; `uv` is.

  Kept out of `verify` deliberately — it needs a Python toolchain that a
  node-only change should not have to have installed.

  A `PreToolUse` hook in `.claude/settings.json` runs `verify` and refuses
  `gh pr create` if it fails, so this rule does not depend on anybody
  remembering it. `scripts/pre-pr-verify.sh` is the script; it exits silently
  for every command that is not a PR creation.

  Three things about that script are load-bearing, all found by reviewing #66
  after it had already merged:

  - **It matches the phrase as a substring, and that is the second answer.** The
    first attempt anchored it to a command position so a `grep` mentioning the
    phrase would not trigger a build. That worked, and it also stopped matching
    `gh pr create; echo done`, `(gh pr create)`, and a newline-separated
    `git push` / `gh pr create` — the shape the `pr` skill itself documents. No
    regex separates running the command from mentioning it, so the question is
    only which way to be wrong. A needless build beats an unverified PR.
  - It verifies the tree named by the payload's **`cwd`**, walking up to the
    nearest `package.json`, and refuses to run anything unless that package is
    `spicy-discount-searcher`. Agents run in worktrees here, and deriving the
    root from `BASH_SOURCE` checked the main checkout instead: clean `main`
    passes, the gate allows, the worktree's broken branch ships. Testing `cwd`
    alone was not enough either — `<worktree>/src` holds no `package.json` and
    fell straight back to the same bug.
  - It **fails closed**, by an `EXIT` trap rather than an `ERR` one, and the
    difference is the whole point. `ERR` does not run for the error class
    `set -u` exists to produce — an unbound variable is a fatal that exits 1
    with empty stdout — and a hook exiting non-zero is treated as a
    _non-blocking_ error, so the command proceeds. The trap also has to
    `exit 0`: printing a refusal alongside a non-zero status is not a refusal.
    A missing `jq`, and a payload `jq` cannot parse, are denials for the same
    reason — each used to leave `command` empty and allow every PR silently.

    The one hole left is death by signal: bash re-raises after the trap, so the
    refusal goes out with a non-zero status and is ignored. Adding `TERM` to the
    trap makes it worse, emitting two documents, so it needs a handler that
    marks the decision rather than a longer trap list.

  `verify` includes `npm audit`, so it needs the network — which costs nothing,
  since `gh pr create` posts to GitHub and could not have run offline anyway. An
  unreachable registry is reported as a network problem rather than a failing
  check, because `npm audit` exits 1 for both.

- **The icon PNGs are generated, and are the one generated artefact with no
  freshness gate.** `public/icons/*.png` come from `assets/icons/*.svg` via
  `npm run icons`. Every other generated file in this repo is pinned by CI —
  the `data` job re-runs `extract_codes.py` and diffs the result — but this one
  cannot be, because it needs macOS's `qlmanage`, `sips` and `python3`. So
  editing an SVG without re-running the script leaves the repo permanently
  inconsistent and nothing anywhere says so. The sources live in `assets/`
  rather than `public/` because vite copies `public/` verbatim into `dist/`,
  which shipped the artwork inside the packaged extension.

  It is a **three**-stage pipeline, and the third stage is the one that gets
  lost: `qlmanage` rasterises, `sips` downsamples, and
  `scripts/round-icon-corners.py` masks the rounded corners back into the alpha
  channel. QuickLook flattens onto an opaque ground, so without that last step
  the icons are solid squares — which has happened twice, once by dropping the
  `rx` from the SVGs and once by a failure between the render and the rounding
  leaving half-built files in `public/`. The script now builds in a temp dir and
  moves into place only on success, and `tests/icons.test.ts` asserts the corner
  is transparent, because that property has silently flipped more than once and
  no toolchain is needed to check it.

- **`src/data/codes.generated.json` is generated.** Never hand-edit it. Change
  `scripts/extract_codes.py` or the workbook and re-run `npm run codes`. CI
  fails the `data` job if the committed JSON doesn't match a fresh run.
- **`src/core/vendors.ts` is the source of truth for hosts.** Adding a vendor
  means adding it there, then updating `public/manifest.json` — `tests/manifest.test.ts`
  pins the two together and will fail if you forget.
- **Three vite builds, on purpose.** MV3 content scripts aren't ES modules, so
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
  and doesn't care. **Avis and Hertz are `'verified'`**; the three hotel
  builders are `'best-effort'`; National is `'driven'`, which is not a grade on
  that scale but a statement that its URL carries no search at all; and Budget,
  Enterprise, Sixt and Starwood build nothing. Both were captured from a search run by hand and then proved
  to _replay_ rather than merely load — Avis by changing the airport and
  watching the results page name Tampa, Hertz by changing it and watching the
  inventory change (36 vehicles at $31-$133 against 31 at $36-$111). Loading
  proves nothing on its own; that is the whole lesson of Enterprise below.

  Hertz needed the second technique because its vehicles step never names the
  location on screen, so there was nothing to read. Differing prices _and_
  counts is what rules out a default search.

  **Budget and Enterprise throw instead of building.** They were
  observed ignoring the query string entirely, and returning a URL for them was
  the worst available option: the landing page answers with a marketing
  "from $19/day", the probe reads it as a real price, and nothing downstream
  can tell — `compare.ts` never reads `confidence`, so it ranks head-to-head
  with the verified vendors and wins on being cheapest. `landedElsewhere`
  cannot catch it either, because `finalPath` is truncated at the first `#` and
  `reservation.html#car_select` therefore compares equal to the path asked for.
  `link-build` is visible; that is not. Same trade as the malformed date and
  the one-way trip.

  **Sixt throws too, and deliberately not for these reasons.** Its landing page
  shows `$35` rather than `from $19/day`, and — the part that matters —
  `landedElsewhere` _did_ catch it: the 302 goes to the bare root, which is the
  one shape that flag recognises, so its quotes were flagged `suspect` and kept
  out of the ranking. It was disabled anyway, because that containment is a
  measurement rather than a property (a locale split to `/en/` would end it) and
  because a vendor that cannot answer still spends a lane and a real tab on
  every run. Reading this bullet as covering Sixt would say the flag never
  fired, when the point is that it did and was still not enough.

  They are also `searchable: false`, which is the half that matters to the user.
  Throwing alone left them selectable, and `interleaveByVendor` round-robins one
  candidate per vendor — so three vendors that could not run took **half** the
  default cap of twelve, and the plan line promised codes the popup already knew
  would fail. (That episode was budget, enterprise and national; Sixt was
  searchable throughout it and left later, on its own evidence.) `starwood` had the same shape and the same answer for years: the
  codes stay in the database, the vendor gets no chip, no candidate, and no host
  permission. Dropping those hosts from the manifest is a real reduction
  in what the extension may read.

  **National left this group.** It has a driver now
  (`src/core/drivers/national.ts`), so its builder returns the page the form
  lives on rather than throwing, and it is `searchable: true` with its host back
  in the manifest. Its confidence is `'driven'` — a third value meaning the URL
  is not carrying the search at all, so it is not graded on the
  reverse-engineering scale and is not counted among the popup's "unverified"
  links. See `docs/driving-a-vendor-form.md`; the checklist there is now a
  worked example rather than a guess.

  `'verified'` is a claim about the **URL shape**, not about every itinerary,
  and the difference is load-bearing. Both were proved on a US airport round
  trip; both hard-code a US country/region and a driver age of 25, and neither
  was tested outside the US. Both therefore **refuse one-way trips** rather than
  guess: Avis honoured `return_location_code` on one replay and ignored it on
  two others, rendering LAX to PHL for a URL asking LAX to LAX, because a return
  location left in the browser session won. The probe tabs share the user's
  profile, so that is reachable in normal use. `popup.ts` also validates the
  IATA shape before any tab opens — failing per-vendor would once have left the
  race to be decided only by Sixt, whose builder took the location as free text
  and was never verified either way. Sixt is `searchable: false` now, so that
  particular escape is closed; the validation stays because the reasoning was
  never about Sixt, but about a whole race being decided by whichever vendor
  fails to notice a bad location.

  The popup's single caveat now renders even when nothing is unverified. It was
  `if (unverified > 0)`, so the moment these two became verified a run of only
  Avis and Hertz — most of the car codes, and the obvious selection once the
  others are known unusable — printed no caveat at all. Silence reads as the
  stronger promise.

  **Each row now carries its own badge**, which is what that paragraph used to
  say was still wanted. `confidenceBadge` prints "url checked" / "url
  unverified" / "form filled" on its own line under the code, so a car race
  mixing all three — Avis and Hertz verified, National driven — is legible per
  row rather than in aggregate. The line under the list stopped counting as a
  result: "2 of these search links are unverified" never said _which_ two, and
  there was nothing on screen to work it out from. It explains the badges that
  are actually present instead, one clause per kind, so it can no longer describe
  a state the list is not in.

  Every label leads with **url** or **form** rather than a bare "checked",
  because the badge renders a few pixels from a dollar amount and "checked"
  beside a price reads as a claim about the price. It is not one.

  A tooltip describes the **route**, never the row's outcome. The `driven` one
  once ended "every field was checked against what the form rendered back",
  which a `form-fill` failure on the same row flatly contradicts — that code
  means a field could not be confirmed. A badge and a status disagreeing on one
  line is the failure this popup exists to prevent, so the tooltip now says what
  a driver does and that it fails rather than guess, and the status is left to
  say whether this row got through. Pinned.

  Two exclusions carried over from the counting version, because both were bugs
  rather than tidiness: a `link-build` quote gets no badge at all (the worker
  stamps those `best-effort` on its catch path, so badging on confidence alone
  would label a link that was never built), and `driven` is never folded in with
  the links, since it has no link to grade.

  Verifying one is worth the effort because the alternative is not "a stale
  parameter" but "no search at all": Enterprise keeps its itinerary in session
  state, so its URL carries nothing and a builder for it cannot exist. Test a
  captured URL in a fresh incognito window before writing one. A `curl` 403
  proves nothing either way — both Enterprise paths return it, including the
  live one.

- **A vendor's own saved state can outrank the URL.** Avis persists its booking
  widget in `localStorage` under `booking-widget.store`, and that state wins over
  the query string: a profile that had once searched Philadelphia rendered
  "Tampa Intl Airport (TPA) - Philadelphia Intl Airport (PHL)" for a link asking
  TPA to TPA. Real page, real prices, different rental — and invisible, because
  `landedElsewhere` only fires on the site root.

  Two halves, deliberately. `src/content/reset-widget-state.ts` clears that key
  at **`document_start`**, which is the only moment before the page hydrates from
  it — the probe runs at `document_idle` and is far too late, which is why this
  is a separate content script rather than a few lines in the existing one. And
  `verify-trip.ts` compares the codes the page _rendered_ against the trip that
  was asked for, so if the prevention ever stops working the quote fails
  `wrong-trip` instead of quietly pricing somebody else's journey. Prevention
  without detection would mean trusting that a fix stayed fixed.

  Both are opt-in per vendor, like the selectors: the storage key and the trip
  summary are one vendor's implementation details, and a false "wrong trip"
  throws away a good quote. The trip check needs an asked-for code rendered
  before it will blame an unexpected one — `(USD)` and `(EST)` are parenthesised
  triplets too, and without that anchor a currency selector above the summary
  would fail every Avis quote in every run. The cost is that a page replacing
  _both_ ends of the trip is invisible to it.

  The clear is gated on the URL being one of ours — the availability path,
  carrying an `awd_number`. Ungated it fires on every avis.com load including
  the user's own browsing, and the damage is not hypothetical: they fill the
  widget by hand, hit Search, and the results navigation erases their drop-off
  before hydration, causing this exact bug on a search nobody asked us about. A
  content script cannot ask whether a run is in flight — messaging is async and
  the page hydrates first — so the gate is what the URL itself can prove. Not
  airtight; registering the script only for the length of a run needs the
  `scripting` permission and belongs with the change that adds it.

  **Confirmed end to end in a loaded extension** — the mechanism was measured
  (clearing the store fixes the page) and `document_start` is documented to run
  before any other script, but whether our injection wins that race against
  Avis's own early scripts was an assumption until a real run returned Avis
  prices. It does.

  **Avis will rate-limit a profile that hits it hard.** Not the bot check —
  that at least offers a way through — but a harder block, where the
  availability page stops serving the check at all. Reached during development,
  after repeated runs racing several Avis codes plus a lot of manual probing in
  one afternoon.

  Deliberately not designed around. Real use is a few searches a trip, weeks
  apart, which is nowhere near that volume; the block is a testing hazard rather
  than a product limit, and building a per-vendor throttle for a ceiling nobody
  reaches in practice would be solving the wrong problem. Worth knowing before
  an afternoon of iterating on Avis, though — when it trips, the tell is an
  availability page that serves neither prices nor a check, and it clears with
  time. If ordinary use ever does reach it, the lever is request volume: a
  per-vendor concurrency of one, or a longer stagger for this vendor.

- Extraction supports per-vendor CSS and falls back to a generic currency sweep.
  All nine vendors define a `container` selector — and until 2026-08-10 **none
  of them scoped anything**, which is the opposite of what this paragraph used
  to claim. Each container is written as a preference list ending in `main`, and
  `querySelector('.vehicle-list, main')` returns whichever element comes first
  in _document order_, not the first selector that matches. `<main>` wraps the
  results, so `main` won on every vendor and every page; the narrow selectors in
  front of it were decoration. `firstMatch` now tries each alternative in turn.
  Found by measuring National, where `.vehicle-list` is real, present, and made
  no difference whatsoever when added. **No vendor defines an `offer` selector**,
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
  `suspect` and — this is the half that was missing — **kept out of the ranking
  entirely**. Flagging alone was not enough: `pricedOnly` filtered on status and
  price only, so the home-page number still entered the primary bucket, still
  won `cheapestComparable`, and `savings` still announced it as the saving. The
  popup badged the row and ranked it first, which reads as an answer with a
  caveat rather than as no answer. Sixt used to make that reachable — its builder
  302s to the site root, where a marketing "$35" sits — and is now
  `searchable: false` for exactly that reason, so nothing routes to it. The
  guard stays: `suspect` is the only unambiguous tell a deep link ever gets, and
  the next vendor to rot will need it. Suspect quotes are listed
  by `unrankedQuotes` instead, the same treatment a mismatched currency gets, so
  the code does not silently vanish. No longer blind for Avis, whose builder now targets
  `/en/reservation/vehicle-availability`, so landing on the root is once again
  the unambiguous tell it is everywhere else — and no longer relevant to Budget,
  which builds no link at all.
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
`cancelled`, `form-fill`, `form-submit`, `code-rejected`, `discount-missing`,
`wrong-trip`. The popup
renders a short phrase per code and keeps the raw message in a tooltip. Assert
the **code** in tests; rewording a message must not change what the system
believes happened.

The three form codes are **on** `PROBE_FAILURES` now, because National ships a
registered driver at a `searchable: true` vendor — a reachable emitter, which is
the whole test that list applies. They were held out while no reachable emitter
existed, since a code admitted early can only ever arrive forged.

They exist for the vendors whose sites ignore the query string entirely:
Enterprise's results page is a bare `#car_select`, Budget's a bare `#/vehicles`.
Those two still refuse to build a URL and are `searchable: false`, so nothing
routes a run to them; their codes stay in the database waiting for a driver that
can run. `code-rejected` is the vendor's verdict on the code rather than a fault in the
run, and it is **the only failure this extension remembers**. A refused code is
recorded in `chrome.storage.local` by `core/rejected-codes.ts` and skipped by
every later plan, because racing it costs a real tab and can only fail again.

`discount-missing` exists to keep that safe, and the split is the whole point.
`code-rejected` is the vendor's own sentence ("this account number cannot be
used online"); `discount-missing` is _our_ inference that a discount did not
land, raised when National's results page names no account. The second is
equally consistent with the code being silently ignored and with our check
having rotted against a redesign — so recording it would let a broken selector
quietly retire a working code, permanently and invisibly. Only the vendor's own
words are durable enough to act on, and the popup says how many codes are being
skipped and offers to try them again.

**The store is written directly, from both sides, and that is a deliberate
retreat.** `recordRejected` is read-modify-write with no atomicity underneath
it, so two refusals settling inside one `get` round trip can lose one, and a
clear written from the popup can land between a worker write's read and its
write. Both are real. Both were fixed, for a while, with a serialised write
queue, a `CLEAR_REJECTED` message round trip, bounded waits on either side, and
eight interacting flags in the popup — and that machinery generated far more
user-visible bugs, over twenty review rounds, than the races it closed ever
could have. The cost of the races is bounded and small: a refusal is missed, a
code is raced once more, one wasted tab. The cost of the machinery was not.

What survives from it is the one part that prevents actual data loss:
`readRejected` distinguishes an unreadable store from an empty one, so a
transient `storage.get` failure cannot make `recordRejected` write a
single-entry list over everything the vendors have already refused. That is ten
lines and no state.

If those races ever need closing again, close them where they are cheap — a
per-vendor lane cap already exists and makes the two-lane case unreachable —
rather than by ordering every write in the extension.

Driving the form is the answer for Enterprise, and the shape of it is now
measured rather than guessed. **The three sentences that used to sit here were
wrong on every count** — they described a multi-step wizard whose real inputs
were `display:none` behind custom controls, with no discount-code field on the
first step, and concluded a single fill-and-submit was the wrong shape. Checked
against the live site on 2026-08-08, `/en/reserve.html` is _one_ visible step:

- `input[name="location-search"]`, an autocomplete; `#sameLocation` reveals a
  second one for a one-way drop-off
- two date controls and two time `select`s, plus `#age`
- **`#cid`** — a plain visible `input[type=text]` labelled "Corporate Account
  Number". That is where the `XZ…` codes go, on step one.

It drives with the ordinary React recipe — native value setter plus
`input`/`change`, `.click()` on the autocomplete option and on "Browse Vehicles"
— and lands on `/en/reserve.html#car_select` with real inventory (71 classes,
$46–$341 for a TPA round trip). Three things that fall out of that run and
should shape the driver when it is written:

- **The results page names the account holder.** IBM's `5666666` rendered
  `I B M CORP (USA)` in the header. That is a per-code verification signal of
  the same kind `verify-trip.ts` gives us for Avis, and it is the good news
  here: it can prove the code _applied_ rather than being silently dropped.
- **Some codes are refused server-side.** Accenture's `XZ15J55` came back with
  "this account number cannot be used online. Please contact your account
  manager." A real answer, not a broken driver, and a distinct outcome from
  "no prices" — it wants its own failure code rather than being folded into
  `form-submit`.
- **Hydration is slow and unreliable.** `#cid` took ~10s to appear on one load
  and ~40s on another, and later would not appear at all: the document returns
  200, the nav and footer render, the booking app never mounts, and the request
  log carries a 503. That is the Avis rate-limit pattern in a different suit,
  reached the same way — repeated loads from one profile in one afternoon.
  Against `PROBE_TIMEOUT_MS` of 45s it is also a live risk to the driver, not
  just a testing hazard.

`?cid=XZ15J55` in the URL does **not** pre-fill the field, so none of this
rescues a deep link. The URL findings below stand unchanged.

**That driver now exists**, in `src/core/form-driver.ts` (the framework) and
`src/core/drivers/enterprise.ts` (the vendor). `docs/driving-a-vendor-form.md`
is the procedure, including the recon snippet to run on Budget and National and
the checklist of everything that has to land in the same change as a
`searchable: true`.

The framework's one rule, which is the whole reason it is not just a sequence of
`querySelector` calls: **every step verifies against what the page then
renders**, and a step that cannot be verified fails the quote. Not "we set the
field" but "the form now shows what we set". `fillLocation` nearly shipped with
that wrong — it confirmed the branch name was on the page, which the suggestion
menu guarantees whether or not the click did anything, so it now requires the
name somewhere the menu is _not_. A test pins that distinction.

**And it is deliberately unreachable.** `FORM_DRIVERS` is empty, Enterprise is
still `searchable: false`, and `enterpriseDriver.drive` always fails — because
the date control was never exercised. Both live runs used the form's default
dates, and the control is custom rather than a `select`, so nothing says the
trip's dates can be set, let alone verified after setting. `applyDates` therefore
refuses outright, and is ordered _before_ the code fill and the submit so a form
that cannot express the trip is never sent. A test asserts that failure; when
the control is measured and driven, that test is replaced rather than deleted.

Everything else in the driver is measured and tested: hydration (with the
throttle case given its own message, because "back off" and "go read the DOM"
are opposite responses), the location autocomplete, the account-number field
with a waited read-back, and all three submit outcomes. `code-rejected` is new
and is the vendor answering rather than anything breaking — the form worked, the
submission worked, and Enterprise said no.

(This paragraph and the matching comment in `messages.ts` were written when the
plumbing landed first and described four vendors deep-linking to `/en/home`,
including Avis. The reconciliation that text asked for is this edit: Avis has a
real search URL now, the other three have none, and `landedElsewhere`'s
docstring has been corrected too.)

`form-fill` is deliberately distinct from `extract-threw`: it fails at the
opposite end, before the page was ever asked for a price, so "no price appeared"
would be a lie.

`PROBE_START` binds a code to a _quote_, not to an _origin_. A tab that
redirects between two matched hosts re-sends `PROBE_READY` under the same tab id
and is handed the original quote's code and vendor — so one vendor's prices
would settle another vendor's quote, labelled with the wrong vendor and code,
`status: 'ok'`.

**No currently matched pair realises that**, and an earlier version of this
paragraph claiming it was "a live bug rather than only a future one" was
overstated. Its evidence was that Avis and Budget share a parent, and Budget
left `host_permissions` when it became unsearchable. The six hosts the manifest
still matches — avis, hertz, nationalcar, hilton, hyatt, marriott — are six
distinct brands with no redirect between them. Sixt left when it became
unsearchable; National arrived with its driver, and it shares a _backend_ with
Enterprise (`prd.location.enterprise.com`) without sharing a matched host. Starwood shares marriott.com but is
`searchable: false`, so it never holds a quote to misattribute. A redirect to a
_sibling_ host of the same brand (`www.hertz.co.uk`) leaves our origins
entirely, which is the `left-our-origins` case and not this one.

It goes live again the moment **any** two matched hosts can redirect to each
other. Related brands make that likely rather than being the condition — an
affiliate hop, a shared booking platform or a country router would do it just as
well — and Budget returning alongside Avis, once something can drive its form,
is the concrete case to expect. Worth fixing then, and worth knowing now:

If it did fire, it would not be caught. The sweep runs on the sibling host
whatever its markup does, because `extract` falls back to `doc.body` when no
`container` matches — **not** because every `container` list happens to end with
`main`, so deleting `main` from those lists looks like a fix and changes
nothing. `landedElsewhere` flags only a redirect landing on a bare `/`, and even
that gets the wrong diagnosis: "the link missed its search" for a link that
reached one, on the wrong site. A driver would make it worse still, typing one
brand's code into another's form.

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
current URL is not one of the six vendor hosts still in the manifest. Not a gap to paper over with a
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

A content script may only claim what it is the sole witness to, which today
means `extract-threw` and `probe-empty` and nothing else. Everything else is the
background's own knowledge, and a page claiming `cancelled` would misattribute
its failure to the user. State the rule when you extend `PROBE_FAILURES`, not a
second copy of the list — the two drifted apart once already.

`form-fill` and `form-submit` satisfy the rule and are still deliberately **not**
on the allowlist, because nothing emits them yet. A code admitted before its
emitter exists can only ever arrive forged, and the popup would print "could not
fill the search form" for a build with no form-filling code in it.

`warn()` in the service worker is the only place this extension logs. There is
no log store and the worker's console dies with it, so the structured fields
above remain the real telemetry — `warn` is the backstop for failures that
belong to no quote (a storage write that failed, a tab or window that would not
close). Never pass it a URL or a code.

## Known gaps

Read the top of this file first: **none of what follows is a reason to touch
Hertz, Avis or National.** Those three work. The open rental-car work is Budget
and Enterprise, and the entries below describe what each of those needs. Sixt is
described below too, but as a closed question rather than as work.

- **The two car vendors that cannot run.** **Budget and Enterprise** are worse
  than unverified: both keep the search in session state, so no query string can
  express it and the builders they have today cannot ever work. They need
  drivers. Neither is reachable at the moment — Enterprise's booking app 503s
  rather than mounting, and Budget raises a bot check on submit.

  **Sixt is no longer one of them, and this entry is the cautionary tale.** It
  used to read "measured-broken but not impossible — it returns the day someone
  captures a URL that reaches a real search", which is the same open-question
  shape as the reverted Avis notes below, and it worked on someone exactly the
  way those did. The URL was captured on 2026-08-12: `/betafunnel/#/offerlist`
  searches on a `BRANCH:<id>` and survives a replay under a deliberately wrong
  title. It changed nothing, because the obstacle was never the URL — **no
  corporate-code field exists anywhere in Sixt's funnel**, and its corporate
  surface is login and registration, so a driver has nothing to drive either.
  Closed, not paused. Racing it uncoded for its retail rate was declined the
  same day: `BRANCH:<id>` is not derivable from an IATA code, LAX has no single
  branch at all, and a hand-captured lookup table would rot silently.

  `unsearchable()` still takes its reason as a whole sentence, which now earns
  its keep twice over — Sixt's refusal borrows neither the other two's "cannot
  be searched by URL" nor its own previous claim to have no working one.

  National keeps its search in session state exactly like Budget and Enterprise
  and is searchable anyway, because it is driven rather than deep-linked. It is
  listed here only as the worked example the other two should follow, not as
  work outstanding.

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

  `KEEPALIVE_CEILING_MS` stops it after ten minutes **with no quote settling** —
  inactivity, not elapsed time. As a wall clock it was reachable by an ordinary
  race (roughly `13 x lanes` codes, so 26 at the default concurrency of two,
  against a popup maximum of 60), and a run past it lost its keepalive mid-race
  and left the rest of its quotes `interrupted` with their tabs open: the exact
  bug this whole section is about, reintroduced by the guard meant to bound it.
  `finishQuote` extends it, so a healthy race never trips it and a stuck one
  still does — and `cancelRun` stops the keepalive when the cancelled run is
  still the current one, because settling every quote to cancel them would
  otherwise buy a wedged run another full ceiling after the user had already
  cancelled it. Guarded on `active === run` rather than unconditional: a cancel
  captures its run and then suspends three times, so an earlier one can resume
  after a newer run is live and clear _its_ interval — which was the
  unconditional version's own regression, and is the same guard teardown and
  `forgetWindowId` already use.

  The ceiling is derived from `PROBE_TIMEOUT_MS + STAGGER_MS` rather than
  written as ten minutes: as inactivity it only has to exceed the longest
  legitimate gap between two settles, which is one lane's deadline plus its
  stagger and does not grow with the number of codes. MV3 suspension
  used to be the backstop for a wedged run — `runQuote` awaits `ensureWindow`
  and `chrome.tabs.create` with no timeout around either, so a lane parked on a
  `windows.create` that never settles ended when Chrome reclaimed the worker.
  Pinning the worker removed that, and would otherwise hold a minimised window
  open indefinitely while the popup looks idle.

  The tests assert the **gap** between pokes, not a count, and the difference is
  the whole mechanism. A count-based version passed while `setTimeout` stood in
  for `setInterval` — a keepalive firing once at 20s and never again, which
  reproduces the original bug exactly. Deleting a guard is the weak mutation
  here; these are the ones that matter, and all five were checked to fail:
  no `startKeepAlive`, no `stopKeepAlive`, one-shot instead of repeating,
  `KEEPALIVE_MS = 29_500` — which leaves no margin for a delayed tick and which
  a "under 30s" assertion would have waved through — and `extendKeepAlive`
  replaced by `startKeepAlive`, which would let a quote settling after the
  ceiling fired resurrect the keepalive it had just given up on.

  One mutation deliberately survives: removing `extendKeepAlive`'s early return
  while keeping its assignment. Writing `keepAliveUntil` with no interval
  running is dead state rather than stale, because `startKeepAlive` overwrites
  it unconditionally before creating one.

- Marking Budget, Enterprise and National unsearchable removed **27 codes and
  six companies** from the popup entirely — `Government of Canada`, `Imaginus`,
  `Michigan State University`, `Purdue / Big TEN`, `UNION Bank/MUFG` and
  `University of Maryland` had no code at any reachable vendor, so they vanished
  from the company list rather than appearing greyed out. Six more dropped out of
  the car list and survived under hotels. There is precedent — twelve
  starwood-only companies have been invisible for as long as that flag has
  existed — and the alternative is listing codes that cannot be raced, but it
  was a real loss and the only explanation lives in the README.

  **National reaching `searchable: true` gives 19 of those codes back**, and
  every one of them arrives through `alsoTryAs`: the workbook files them all
  under Enterprise and contains no `vendor: 'national'` record at all. Asking
  `buildCandidates` for Enterprise therefore returns National candidates, which
  reads oddly and is correct — `wanted` is widened by `alsoTryAs` before the
  search, the codes are the same codes, and nothing is routed to the vendor that
  cannot run them. The README's tally needs revisiting against what is still
  missing.

- **Two old Avis notes, kept as background and _not_ as work.** Both used to be
  phrased as open questions with a named fix attached, which is the shape of text
  a future session acts on. One of them is precisely what PR #60 acted on, and
  that PR broke production and was reverted. Avis works; the reactive-only rule
  at the top of this file governs both of these.

  _Concurrent tabs and `localStorage`._ At concurrency two or more, each probe
  tab clears `booking-widget.store` while Avis rewrites it from its own URL, so
  if that store carried the AWD then tab A could render tab B's code —
  `verify-trip` would not catch it, since it compares only locations. This was
  chased on 2026-08-11 and the cap it produced was reverted: the store carries no
  code, and the user reports different codes returning different prices in real
  runs, which contradicts the premise the cap rested on. **Do not cap Avis, and
  do not go measuring for a reason to.** If two lanes ever genuinely settle on
  one code, that is a symptom and it will show up as one.

  _The reset's gate could be made ours rather than merely narrow._ `awd_number`
  is produced by Avis's own search flow too, so the reset can still fire on a
  user's hand-run search. A URL fragment never reaches the server and only we
  would emit one; `chrome.scripting.registerContentScripts` for the length of a
  run is the other shape. Neither is planned. Recorded so that whoever meets the
  behaviour knows it was understood, not so that someone implements it.

- Hotel support is wired end to end but has had far less thought than cars.
- No end-to-end test that actually loads the extension in a browser.
- Most of `src/popup/popup.ts`'s _logic_ is still unpinned — the comparison
  warnings, the plan line's wording, saved-selection persistence. Its
  import-time contract is not: `tests/popup-contract.test.ts` loads the real
  `index.html` into jsdom and imports the module, so a renamed id fails the
  suite. It used to fail nothing, while bricking the popup.

  The confidence badges and the caveat line beneath them are pinned now, driven
  through a real `RUN_STATE` broadcast rather than by calling the renderer: what
  each confidence prints, that a `link-build` quote prints nothing, and that the
  caveat describes only the kinds actually on screen.

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
