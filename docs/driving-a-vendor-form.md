# Driving a vendor's form

For the vendors whose URL cannot express a search. README's
[Fixing a deep link](../README.md#fixing-a-deep-link) covers the other kind;
this is what to do when there is no link to fix.

Budget, Enterprise and National keep the itinerary in session state. No query
string carries it, so the only route to a price is to open their form and fill
it in. `src/core/form-driver.ts` is the framework, `src/core/drivers/index.ts`
the registry, and **`src/core/drivers/national.ts` is the worked example** — the
first driven vendor to ship, proved against the live site. `drivers/enterprise.ts`
is the second, and the one to read for a form whose date control is a range
picker. Budget is the only car vendor still `searchable: false`.

## The rule that matters

**Every step verifies against what the page then renders.** Not "we set the
field", but "the form now shows what we set". A deep link that rots usually
lands somewhere obviously wrong; a driver that half-works submits a form with
one field stale and returns a real price for a rental nobody asked for. A step
that cannot be verified must fail the quote — `form-fill` is visible in the
popup, a wrong price is not.

`enterpriseDriver` refused to run for months on exactly this principle:
everything about it was measured except the date control, so it stopped there
rather than submit a search for the form's default dates. That refusal was
deleted on 2026-08-12 by measuring the control, not by deciding the risk was
acceptable — which is the only way one of these should ever be removed.

## Recon: what to capture

Paste this into the console on the vendor's booking page, once the form has
rendered. It dumps the facts a driver needs and nothing else.

```js
(() => {
  const vis = (e) => !!e.offsetParent;
  const t = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    url: location.origin + location.pathname,
    hash: location.hash,
    fields: [...document.querySelectorAll('input,select,textarea')].map((e) => ({
      tag: e.tagName,
      type: e.type,
      id: e.id,
      name: e.name,
      placeholder: e.placeholder,
      aria: e.getAttribute('aria-label'),
      visible: vis(e),
      value: e.value,
      options: e.tagName === 'SELECT' ? e.options.length : undefined,
    })),
    buttons: [...document.querySelectorAll('button,[role="button"],input[type=submit]')]
      .filter(vis)
      .map((e) => ({ text: t(e), id: e.id, cls: String(e.className).slice(0, 50) })),
    // The date control is the step every driver so far has died on. If it is
    // not in `fields` above, it is a custom widget and needs opening.
    dateish: [...document.querySelectorAll('*')]
      .filter(vis)
      .filter((e) => e.children.length === 0 && /^\d{1,2}$|^\d{4}$|^[A-Z][a-z]{2}$/.test(t(e)))
      .slice(0, 20)
      .map((e) => ({ text: t(e), tag: e.tagName, cls: String(e.className).slice(0, 40) })),
  };
})();
```

**Pick the hydration marker from the widget, not from the server.** Before
anything else, fetch the page and grep the raw HTML for the selectors you plan
to wait on:

```js
const html = await fetch(location.pathname, { credentials: 'include' }).then((r) => r.text());
['#the-field', '.the-submit-button'].map((s) => [s, html.includes(s.slice(1))]);
```

Anything already in that HTML is **static markup and proves nothing** — it is
present before a single line of the vendor's JavaScript has run. National's
location input is served this way while its submit button is not, so waiting for
the input returned instantly on a cold page; the driver typed into a component
that was not listening, the keystroke vanished, and the run died at the _next_
step with "timed out waiting for the autocomplete". Wait for something the widget
itself creates.

Then type defensively anyway. A marker narrows the race, it does not close it,
and one event into a component that is not listening leaves nothing to wait for
— so re-apply the value while the thing you expect has not appeared.

**That paragraph has now been ignored once, at a cost.** Enterprise's driver
picked a good marker and then typed with a bare `waitFor`, and its first live run
failed at exactly the step above — the user's report was that it was "failing to
select the location". A good marker made the second half feel unnecessary; it is
not, because the two guard different things. The marker says the widget rendered;
nothing says it has finished binding handlers, and `#cid` is a different
component from the location field in any case. Enterprise is the sharper version
of National's lesson rather than an exception to it: grepping its served
`/en/reserve.html` finds **zero `<input>` elements at all**, so every field is
widget-built and every one of them is subject to this race.

**Test in a hidden tab.** Probe tabs live in a minimised window, so
`setTimeout` is throttled to roughly once a second: a 250 ms poll costs 1 s of
budget. Open the page, switch to another tab, and drive it from there. National's
whole fill takes about 5 s that way — comfortably inside its share of the probe
deadline, but only because it was measured rather than assumed.

**Drive a date the calendar is not already showing.** A two-month calendar
opening on today's month makes every test date next week work and every real
booking fail. National's shows August and September and pages one month at a
time; a perfectly ordinary October trip found nothing and burned the whole
drive budget waiting. Test with a date far enough out to need paging, and check
whether "Previous" is disabled at the current month.

Then, for each field the trip needs, answer three questions:

1. **How is it set?** Try `setNativeValue` first — it works on anything backed
   by a real `input`/`select`, including React-controlled ones. If nothing
   happens, it is a custom widget and needs clicking.
2. **How is the result confirmed?** Find the text the form renders back once the
   field holds a value. This is the half people skip.
3. **What does a wrong answer look like?** Load the page with a _different_
   value already in session state and check the verification catches it.

Then submit, and record all three outcomes: the success signal (Enterprise sets
`#car_select` on the URL), whatever the vendor says when it refuses the code,
and what "nothing happened" looks like.

## Vendor state

The four car vendors marked **yes** below are **finished** — Hertz, Avis,
National and Enterprise return real prices and are not work in progress. Car work
means Budget. See the top of `CLAUDE.md` for why that boundary is written down
rather than assumed.

| Vendor                    | Searchable | Where it stands                                                                                                                                  |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Avis                      | yes        | Deep link `verified`, replay-proved, widget-reset + trip-check                                                                                   |
| Hertz                     | yes        | Deep link `verified`, differential-replay-proved                                                                                                 |
| Sixt                      | no         | **Closed.** Its search URL works and replays; no corporate-code field exists anywhere in its funnel, so a driver has nothing to drive. See below |
| Enterprise                | **yes**    | Driven, not deep-linked. Range-picker calendar and time dropdowns driven and verified; capped at one lane; 120s probe budget                     |
| Budget                    | no         | Form fully mapped and the easiest to fill; submitting raises a bot check, which `#budget-captcha-btn` now puts the user in front of. See below   |
| National                  | **yes**    | Driven, not deep-linked. Proved against the live site with a controlled differential; capped at one lane                                         |
| Hilton / Marriott / Hyatt | yes        | `best-effort`, never checked against the live site                                                                                               |
| Starwood                  | no         | Correctly so; folded into Marriott in 2018, no site to search                                                                                    |

## National — measured 2026-08-08, and the furthest along

Reconnaissance run against `https://www.nationalcar.com/en/home.html`, which was
**not** throttling. The form is on the home page, not a `/reserve` route.

| Piece                 | How                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location              | `#search-autocomplete__input-PICKUP`; options are `button.search-autocomplete__result` (the `<li>` around them is **not** clickable)                              |
| Location readback     | a chip reading `Tampa International Airport (TPA)`; the input's own value is cleared on selection                                                                 |
| Pick-up / return date | `#date-time__pickup-toggle` / `#date-time__return-toggle` — `<button role="combobox">`, no hidden input                                                           |
| Day cell              | `button.date-selector__day[aria-label="September 4"]`, inside `.date-selector__month-wrapper[aria-label="Calendar - September 2026"]`; past days carry `disabled` |
| Date readback         | the toggle's own text becomes `Sep 4`                                                                                                                             |
| Times                 | `#PICKUP` / `#RETURN` `<select>`, value is a half-hour index from midnight (`24` = 12:00 PM)                                                                      |
| Age                   | `#age-selector`                                                                                                                                                   |
| Account number        | `button.contract-promo__tog` ("ACCOUNT NUMBER / COUPONS") reveals `#contract__input`                                                                              |
| Account readback      | the toggle's label becomes `ACCOUNT NUMBER (5666666) / COUPONS`                                                                                                   |
| Submit                | `button.booking-widget__go-cta`, "CHECK AVAILABILITY"                                                                                                             |

**The date control is driven and verified** — the blocker that stopped
Enterprise. Clicking the toggle and then the day button, both synthetically,
moved the field to `Sep 4`, and the toggle's text is a free readback. Note the
return calendar opens on the pick-up's month, so the two toggles do not show the
same months.

**There is an auth interstitial.** Submitting opens a "Sign in or Continue as a
Guest" modal; the search only runs after **CONTINUE AS GUEST**. That is
declining to authenticate, not authenticating, so a driver may click it — but it
is a step, and it is why an earlier attempt looked like the submit had silently
done nothing.

Results land on `/en/reserve.html#/car_select` (note the slash, unlike
Enterprise's `#car_select`), title "Select Vehicle". **The results page renders a
full trip summary — `TPA Sep 4 at 12:00 PM … Sep 6 at 12:00 PM`** — which is a
better verification signal than any other vendor here offers: location _and_
both dates, checkable against the trip. Retail baseline for that itinerary was
$74.00/day, $193.80 total.

### Proved 2026-08-10 — the code applies, and it moves the price

A controlled differential, same session, same trip, minutes apart:

|                            | with `5666666`      | control             |
| -------------------------- | ------------------- | ------------------- |
| `ACCOUNT NAME`             | `I B M CORP (USA)`  | absent              |
| rate label                 | "Custom Rate"       | absent              |
| Compact SUV (Hyundai Kona) | $70.30/day, $185.05 | $74.00/day, $193.80 |
| results                    | 34                  | 34                  |

Same vehicle, same result count, different price. Two runs is what makes this a
measurement rather than a hopeful anecdote — a single discounted run cannot tell
"the code applied" from "prices moved since Tuesday", which is exactly the trap
`deeplinks.ts` describes for a URL that merely loads.

`src/core/drivers/national.ts` is the driver, and it is fully tested. Both of
last session's open questions closed:

- The focus sensitivity is real but is not a property of the site — it was an
  artefact of driving the field across several separate evaluations. Done in one
  pass, keeping focus, the autocomplete behaves.
- Everything is verified by readback: the location chip must render `(TPA)`, each
  date toggle must read `Sep 4`, the account field must keep the code, and the
  **results page must carry `ACCOUNT NAME`** — its absence is `code-rejected`,
  because that is precisely the control run and its prices are retail.

### Why National is still not registered

**It carries the previous search in session state — location, dates _and_ the
account number.** Reloading the form showed the chip, both dates, and
`#contract__input` still holding `5666666`, with the toggle reading
`Account Number (I B M CORP (USA)) / Coupons`.

Two consequences. The first is handled: a stale chip suppresses the autocomplete
outright, so `clearStaleLocation` removes it before typing — a regression test
covers a run that starts from stale state, and deleting the clear fails it.

The second was the blocker and is now handled: **concurrent National tabs in one
profile share that state**, so two lanes racing two codes can settle on one. The
`ACCOUNT NAME` check does not save us there — both tabs would render the same
name, and nothing maps a code to the name it should produce.

`Vendor.maxLanes` is the answer. A lane takes the first queued quote whose vendor
has a free slot and _skips past_ a capped one, so a single National tab in flight
never idles a lane that could be pricing Hertz; when everything left is capped,
the lane parks on a waiter rather than spinning or returning — returning would
drop those quotes with the run reported complete. National and Enterprise are
both `maxLanes: 1`.

Avis was once suspected of the same hazard and **is not a task**. It was capped
on that suspicion on 2026-08-11, in a change reverted the same day, and the
premise turned out to be wrong: the user sees different prices for different
codes in real runs, which is the very evidence the cap's argument claimed could
not exist. Avis works uncapped. Leave it uncapped, and do not go looking for a
measurement that would justify revisiting it — that is the loop this file and
`CLAUDE.md` now exist to close.

Incidentally confirmed: National and Enterprise really do share a backend. The
lookup goes to `prd.location.enterprise.com/enterprise-sls/search/location/national/…`.
That supports the `alsoTryAs` link between them, though it says nothing about
whether a given contract id is valid at both.

## Budget — mapped, then blocked by a bot check

`https://www.budget.com/en/home`, an AngularJS form (`ng-pristine` classes).
Easier to fill than either of the others:

| Piece    | How                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Location | `#PicLoc_value` (`name="anguPicLoc"`), free text, no suggestion menu observed                                                  |
| Dates    | **`#from` and `#to` are plain text inputs**, placeholder `mm/dd/yyyy`                                                          |
| Times    | `select[name="reservationModel.pickUpTime"]` / `…dropTime`, 48 options                                                         |
| Discount | `button.customer-discount-toggle` reveals `#awd` (placeholder **"BCD Code"**), `#coupon`, and `#res-home-wizNum` (Customer ID) |
| Submit   | `button.selectMyCar`, "Show Cars"                                                                                              |

The dates are the good news: `setNativeValue(from, '09/04/2026')` took, so no
calendar driving is needed at all, and `usDate()` in `deeplinks.ts` already emits
exactly that format.

**But submitting raises a bot check** — a full-page "Verification Required /
Slide right to secure your access" challenge. That was reached on the first
submission from a clean page, with every field filled synthetically.

An earlier draft of this section called that **permanently unsearchable**. That
was wrong, and the disproof was already in this repo: Avis shows a bot check too,
and the answer to it has shipped for months — `#avis-captcha-btn` opens one
ordinary focused tab, the user passes the check themselves, and the clearance it
leaves in the profile is what the probe tabs then ride on for the session. The
extension never answers a challenge; it just puts a human in front of one.

Budget now has the same affordance, `#budget-captcha-btn`, with one honest
difference. Avis carries its check on the availability page, so its button lands
on the check itself and the chore is a single click. Budget's appeared only on
_submitting_ a search, so its button lands on the form and the user has to run
one search to raise it. Capturing the URL the challenge is served at would make
this one-click too — nobody recorded it, and that is the cheapest improvement
here.

So Budget is blocked on two things, neither of them a wall:

1. **Does a human pass actually clear it for later automated submits?**
   Untested, and the only question that matters. The Avis precedent says a
   profile-level clearance is the usual shape, but that is a precedent rather
   than a measurement of Budget. Press the button, pass the check by hand, then
   re-run the synthetic fill from the table above and see whether it reaches
   results.
2. **The driver itself**, which cannot be written until (1) lets a run reach a
   results page worth reading.

What stays true regardless: nothing in this codebase may solve or evade a
challenge, and no amount of clearance changes the politeness posture — Budget
gets the same capped concurrency and stagger as everyone else.

**Sixt is unsearchable now, and the decision this used to ask for was made.**
It was the only vendor that was `searchable: true` while being _known_ not to
reach a search: its builder 302s to the site root, where a marketing "$35" sits.

The argument for leaving it on was that the damage was contained —
`landedElsewhere` flags a home-page landing `suspect` and `compare.ts` keeps
suspect quotes out of the ranking. That containment is a measurement rather than
a property: it holds only while the redirect target is the bare root, and a
locale split to `/en/` would put that $35 back into the ranking with nothing on
screen to say so. Meanwhile a vendor that cannot answer still spent a lane and a
real tab on every run — now against a codes cap of 100 rather than 12.

It costs three codes and no company: every company with a Sixt code has one at
another car vendor, so nothing disappears from the picker. `sixt.com` is out of
the manifest too, which is a real reduction in what the extension may read.

This paragraph used to end "that difference decides whether the next person
should go looking for a URL. **They should.**" Somebody did, on 2026-08-12, and
the answer closed the vendor rather than opening it — which is worth leaving on
the page, because this document exists to tell people which vendor to pick up
next and it was pointing at the wrong one.

`/betafunnel/#/offerlist` searches correctly on a `BRANCH:<id>` and survives a
replay under a deliberately contradictory title, so the URL was never the
obstacle. **There is no corporate-code field anywhere in Sixt's funnel** — not
the home form, not the results page, not the booking-option step — and its
corporate surface is login and registration. That closes the driver route too,
and it is the one relevant fact for _this_ document: the recon procedure below
assumes there is a field to find. For Sixt there is nothing to drive, so no
amount of the checklist that follows will help.

Reopening it needs credentials for a Sixt business account, not another URL.
`src/core/deeplinks.ts` carries the parameters and the full finding, including
why racing it uncoded for its retail rate was declined as well.

## Reading a page that has no layout

The single hardest bug in this whole exercise, and worth its own section because
every driver will hit it.

A probe tab lives in a **minimised window**, so nothing is rendered and
`innerText` returns an empty _string_ — not `undefined`. A fallback written
`innerText ?? textContent` therefore yields `''`, and every text-based lookup in
a driver silently reads nothing: matching a suggestion, finding a button by its
label, reading a date back. It survives review, unit tests (jsdom leaves
`innerText` undefined, so `??` reaches `textContent`) and hand-testing (ad-hoc
console scripts get written `a || b`, so the throwaway harness is _more_ robust
than the shipped code).

The fix is `||`, and then immediately a second problem: `textContent` includes
the source of every inline `<script>`. A page shipping an error catalogue or an
analytics payload will happily supply the exact phrase a check is looking for.
Use `visibleText` from `form-driver.ts`, which walks text nodes and skips
`script`, `style`, `noscript` and `template`.

Timers are throttled to roughly once a second in that tab too, so a 250 ms poll
costs a second of budget — measure a drive there, never in a visible tab.

## Before flipping `searchable: true`

Landing a driver is not one change. All of these belong in it — National went
through every one of them, so this list is now a worked example rather than a
guess:

- **Register the driver** in `FORM_DRIVERS`. Writing one does not enable it.
- **Cap the vendor to one lane** if its site keeps the search in session state —
  now just `maxLanes: 1` in `vendors.ts`. Already set for National and
  Enterprise. Done, for those two.
- **Make the builder return the driver's `startUrl`** instead of throwing.
  `unsearchable()` is what `makeQuote` catches today, and a caught throw settles
  the quote at plan time so it never reaches a lane at all — which is why a
  driver alone changes nothing.
- **Check the probe budget against the vendor's hydration.** Deliberately not
  raised for National: its widget mounted in about 8s, and `DRIVE_SHARE` of 0.6
  leaves the driver ~27s of the 45s default, which its measured runs fit inside
  comfortably.

  **Enterprise forced the question, as this list predicted it would**, and the
  answer was a per-vendor `probeTimeoutMs` rather than a bigger default. Its
  widget took ~40s to mount on one measured load, which leaves nothing for
  filling, submitting or pricing. The default stays 45s because it is also a
  politeness setting — it bounds how long a tab sits open on _every_ vendor's
  site, and Hertz, Avis and National answer well inside it. Paying Enterprise's
  cost everywhere would have been the lazy version of this fix.

  Note `KEEPALIVE_CEILING_MS` still derives from the **default**, not from the
  longest budget any vendor asks for — and leave it that way. This paragraph
  said the opposite for a while, on the theory that a ceiling shorter than a
  single quote's own budget would let slow quotes trip their own inactivity
  guard. The arithmetic refutes it: `13 x (45s + 750ms)` is 9.9 minutes against
  a 120s quote, five times over. Deriving from the longest pushed the ceiling to
  26 minutes, which is how long a _wedged_ run pins the worker with a minimised
  window open, for no benefit. There is headroom for a vendor budget of about
  eight minutes before the reasoning changes. `DRIVE_SHARE` is still a guess.

- **Admit `form-fill`, `form-submit` and `code-rejected`** to `PROBE_FAILURES`.
  Done — National's driver is a reachable emitter for all three, and each is
  something only the page can witness. They were held out while no reachable
  emitter existed, because a code admitted early can only ever arrive forged.
- **Decide what `LinkConfidence` means for a driven vendor.** Settled:
  `'driven'`, a third value that says the URL is not carrying the search at all.
  It is deliberately not counted among the popup's "reverse-engineered and
  unverified" links — there is no reverse engineering in it, and a driven vendor
  checks more than a verified deep link does.
- **Add the host** to `public/manifest.json`. `tests/manifest.test.ts` pins it
  against `vendors.ts` and will fail if you forget.
- **Check what comes back into the popup.** Marking the three unsearchable
  removed 27 codes and six companies; National returns 19 of those codes, and it
  gets them entirely through `alsoTryAs` — the workbook files every one under
  Enterprise and has no `vendor: 'national'` record at all.
- **Watch for a duplicate key.** Adding `searchable: true` above an existing
  `searchable: false` in `vendors.ts` silently kept the old value; the later one
  wins and TypeScript said nothing. Caught by reading the file back, not by the
  compiler.
