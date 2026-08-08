# Driving a vendor's form

For the vendors whose URL cannot express a search. README's
[Fixing a deep link](../README.md#fixing-a-deep-link) covers the other kind;
this is what to do when there is no link to fix.

Budget, Enterprise and National keep the itinerary in session state. No query
string carries it, `deeplinks.ts` refuses to build one, and all three are
`searchable: false`. The only route to a price is to open their form and fill it
in — `src/core/form-driver.ts` is the framework and
`src/core/drivers/enterprise.ts` is the worked example.

## The rule that matters

**Every step verifies against what the page then renders.** Not "we set the
field", but "the form now shows what we set". A deep link that rots usually
lands somewhere obviously wrong; a driver that half-works submits a form with
one field stale and returns a real price for a rental nobody asked for. A step
that cannot be verified must fail the quote — `form-fill` is visible in the
popup, a wrong price is not.

This is why `enterpriseDriver` refuses to run today. Everything about it is
measured except the date control, so it stops there rather than submit a search
for the form's default dates.

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
      tag: e.tagName, type: e.type, id: e.id, name: e.name,
      placeholder: e.placeholder, aria: e.getAttribute('aria-label'),
      visible: vis(e), value: e.value,
      options: e.tagName === 'SELECT' ? e.options.length : undefined,
    })),
    buttons: [...document.querySelectorAll('button,[role="button"],input[type=submit]')]
      .filter(vis).map((e) => ({ text: t(e), id: e.id, cls: String(e.className).slice(0, 50) })),
    // The date control is the step every driver so far has died on. If it is
    // not in `fields` above, it is a custom widget and needs opening.
    dateish: [...document.querySelectorAll('*')].filter(vis)
      .filter((e) => e.children.length === 0 && /^\d{1,2}$|^\d{4}$|^[A-Z][a-z]{2}$/.test(t(e)))
      .slice(0, 20).map((e) => ({ text: t(e), tag: e.tagName, cls: String(e.className).slice(0, 40) })),
  };
})();
```

Then, for each field the trip needs, answer three questions:

1. **How is it set?** Try `setNativeValue` first — it works on anything backed
   by a real `input`/`select`, including React-controlled ones. If nothing
   happens, it is a custom widget and needs clicking.
2. **How is the result confirmed?** Find the text the form renders back once the
   field holds a value. This is the half people skip.
3. **What does a wrong answer look like?** Load the page with a *different*
   value already in session state and check the verification catches it.

Then submit, and record all three outcomes: the success signal (Enterprise sets
`#car_select` on the URL), whatever the vendor says when it refuses the code,
and what "nothing happened" looks like.

## Vendor state

| Vendor | Searchable | Where it stands |
| --- | --- | --- |
| Avis | yes | Deep link `verified`, replay-proved, widget-reset + trip-check |
| Hertz | yes | Deep link `verified`, differential-replay-proved |
| Sixt | **yes** | Builder measured to 302 to the site root. Enabled but useless — see below |
| Enterprise | no | Driver written and tested; blocked on the date control |
| Budget | no | Form fully mapped and the easiest to fill; submitting raises a bot check, which `#budget-captcha-btn` now puts the user in front of. See below |
| National | no | Form fully mapped, date control driven and verified. Two questions open. See below |
| Hilton / Marriott / Hyatt | yes | `best-effort`, never checked against the live site |
| Starwood | no | Correctly so; folded into Marriott in 2018, no site to search |

## National — measured 2026-08-08, and the furthest along

Reconnaissance run against `https://www.nationalcar.com/en/home.html`, which was
**not** throttling. The form is on the home page, not a `/reserve` route.

| Piece | How |
| --- | --- |
| Location | `#search-autocomplete__input-PICKUP`; options are `button.search-autocomplete__result` (the `<li>` around them is **not** clickable) |
| Location readback | a chip reading `Tampa International Airport (TPA)`; the input's own value is cleared on selection |
| Pick-up / return date | `#date-time__pickup-toggle` / `#date-time__return-toggle` — `<button role="combobox">`, no hidden input |
| Day cell | `button.date-selector__day[aria-label="September 4"]`, inside `.date-selector__month-wrapper[aria-label="Calendar - September 2026"]`; past days carry `disabled` |
| Date readback | the toggle's own text becomes `Sep 4` |
| Times | `#PICKUP` / `#RETURN` `<select>`, value is a half-hour index from midnight (`24` = 12:00 PM) |
| Age | `#age-selector` |
| Account number | `button.contract-promo__tog` ("ACCOUNT NUMBER / COUPONS") reveals `#contract__input` |
| Account readback | the toggle's label becomes `ACCOUNT NUMBER (5666666) / COUPONS` |
| Submit | `button.booking-widget__go-cta`, "CHECK AVAILABILITY" |

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
better verification signal than any other vendor here offers: location *and*
both dates, checkable against the trip. Retail baseline for that itinerary was
$74.00/day, $193.80 total.

Two things still open, both of which must be closed before a driver ships:

- **Does the account number change the price?** Not verified. The successful
  end-to-end run was the retail one; the run carrying `5666666` never reached
  results. For a discount-code racer this is the load-bearing question.
- **The location autocomplete is focus-sensitive.** The suggestion request fires
  and returns 200, but the menu does not render — or closes again — when the
  field loses focus, which a driver polling from another context can easily
  cause. A content script must keep focus on the field while suggestions arrive.

Incidentally confirmed: National and Enterprise really do share a backend. The
lookup goes to `prd.location.enterprise.com/enterprise-sls/search/location/national/…`.
That supports the `alsoTryAs` link between them, though it says nothing about
whether a given contract id is valid at both.

## Budget — mapped, then blocked by a bot check

`https://www.budget.com/en/home`, an AngularJS form (`ng-pristine` classes).
Easier to fill than either of the others:

| Piece | How |
| --- | --- |
| Location | `#PicLoc_value` (`name="anguPicLoc"`), free text, no suggestion menu observed |
| Dates | **`#from` and `#to` are plain text inputs**, placeholder `mm/dd/yyyy` |
| Times | `select[name="reservationModel.pickUpTime"]` / `…dropTime`, 48 options |
| Discount | `button.customer-discount-toggle` reveals `#awd` (placeholder **"BCD Code"**), `#coupon`, and `#res-home-wizNum` (Customer ID) |
| Submit | `button.selectMyCar`, "Show Cars" |

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
*submitting* a search, so its button lands on the form and the user has to run
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

**Sixt is the odd one out and deserves a decision.** It is the only vendor that
is `searchable: true` while being *known* not to reach a search: its builder
302s to the site root, where a marketing "$35" sits. The damage is contained —
`landedElsewhere` flags the quote `suspect` and `compare.ts` keeps suspect
quotes out of the ranking — but it still spends a tab and a lane on every run to
produce a number that cannot be used. The containment also holds only while the
redirect target is the bare root; a locale split to `/en/` would put that $35
back into the ranking with nothing on screen to say so. Either capture a working
URL or make it unsearchable.

## Before flipping `searchable: true`

Landing a driver is not one change. All of these belong in it:

- **Register the driver** in `FORM_DRIVERS`. Writing one does not enable it.
- **Raise `PROBE_TIMEOUT_MS`.** Enterprise's widget took ~40s of the current 45s
  budget to hydrate on one measured load. `KEEPALIVE_CEILING_MS` is derived from
  this constant, so it is a deliberate change, not a nudge. `DRIVE_SHARE` in
  `probe.ts` splits the budget between driving and pricing and is currently a
  guess.
- **Admit `form-fill`, `form-submit` and `code-rejected`** to `PROBE_FAILURES`
  in the service worker. They are held out precisely because no *reachable*
  emitter exists yet; the moment one does, they should be admitted in the same
  change.
- **Decide what `LinkConfidence` means for a driven vendor.** Neither `verified`
  nor `best-effort` says anything true about a URL whose correctness is
  irrelevant — the driver's own verification is what earns trust. The popup
  counts `best-effort` quotes to decide its caveat.
- **Add the host** to `public/manifest.json`. `tests/manifest.test.ts` pins it
  against `vendors.ts` and will fail if you forget.
- **Check what comes back into the popup.** Marking these three unsearchable
  removed 27 codes and six companies; re-enabling one returns some of them.
