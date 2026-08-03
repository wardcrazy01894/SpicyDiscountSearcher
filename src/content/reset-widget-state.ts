/**
 * Clear the vendor's own persisted search widget before its page reads it.
 *
 * Avis keeps the booking widget's form state in `localStorage` under
 * `booking-widget.store`, and that state **takes precedence over the query
 * string**. A profile that has ever searched Avis by hand therefore overrides
 * every deep link we open: asking for `pickup_location_code=TPA` with
 * `return_location_code=TPA` rendered "Tampa Intl Airport (TPA) - Philadelphia
 * Intl Airport (PHL)", because Philadelphia was left in the store days earlier.
 *
 * That is the worst shape of failure this extension has: the path is right, the
 * page is real, the prices are real, and they are for a different rental. The
 * probe cannot tell, `landedElsewhere` only fires on the site root, and the
 * quote ranks like any other.
 *
 * Measured: clearing that key and re-opening the same URL changed the header to
 * "Tampa Intl Airport (TPA) - Select drop-off location" and left the prices
 * rendering. The site then re-populates the store from the URL rather than from
 * the stale copy.
 *
 * Runs at `document_start` — the whole point. Chrome injects there before the
 * document element has children, so an inline `<head>` script hydrating the
 * store runs after us. The probe runs at `document_idle`, long after the page
 * has already made that decision, which is why this is a separate script rather
 * than a few lines in that one.
 */

/**
 * Only `booking-widget.store`, and only that.
 *
 * An earlier version also cleared `recent-search-options` and
 * `recent-location-options`. Neither was ever measured as necessary — they were
 * added defensively — and they are the user's own data on a site they use. The
 * measurement was of this key alone, so this is what gets cleared.
 */
const STALE_KEY = 'booking-widget.store';

/**
 * Only on the page we drove the browser to, and only when it carries our own
 * search.
 *
 * Without this gate the script fires on *every* avis.com page load, including
 * the user's ordinary browsing when no run is active. The damage that does is
 * not hypothetical: they fill the widget by hand, hit Search, and the results
 * navigation triggers a clear that erases their drop-off before the page
 * hydrates — producing exactly the "Select drop-off location" state this file
 * was written to *cause* on purpose. Corrupting a first-party search nobody
 * asked us about is worse than the bug being fixed.
 *
 * A content script cannot ask the background whether a run is in flight —
 * messaging is async and the page hydrates first — so the gate is what the URL
 * itself can prove.
 *
 * **`awd_number` is weaker evidence than it looks, and this repo contains the
 * disproof.** An earlier version of this comment claimed only our deep link
 * puts a code there. It does not: `deeplinks.ts` records that Avis's URL was
 * captured *from a search run by hand* with a corporate AWD applied, so the
 * vendor's own flow produces exactly this shape. A user who types their
 * employer's AWD into the widget and hits Search lands on this path with this
 * parameter, and we clear their store mid-navigation — which for a one-way
 * hand search is precisely the bug this file exists to prevent, inflicted on a
 * search nobody asked us about.
 *
 * So the gate narrows the blast radius from "every avis.com page load" to "an
 * availability search carrying a discount code", and no further. What would
 * actually close it: registering this script only for the length of a run
 * (`chrome.scripting.registerContentScripts`, which needs the `scripting`
 * permission), or a marker only we emit — a URL fragment never reaches the
 * server, so it would cost nothing, but whether Avis's router tolerates one is
 * unverified and guessing at it is how this file's previous claim got written.
 */
const OUR_SEARCH_PATH = '/en/reservation/vehicle-availability';

export function shouldClear(url: URL): boolean {
  return (
    url.host === 'www.avis.com' &&
    url.pathname === OUR_SEARCH_PATH &&
    url.searchParams.has('awd_number')
  );
}

export function clearStaleState(
  url: URL,
  readStorage: () => Pick<Storage, 'removeItem'> | undefined,
): boolean {
  if (!shouldClear(url)) return false;
  try {
    // Read inside the try, not outside. Chrome throws `SecurityError` on the
    // property *access* when site data is blocked, which is the "disabled" case
    // the catch below names — so taking it as an argument gave assurance the
    // code had not earned.
    const storage = readStorage();
    if (!storage) return false;
    storage.removeItem(STALE_KEY);
    return true;
  } catch {
    // Storage can be unavailable (partitioned, disabled, quota-evicted). A
    // failure here costs accuracy on this one quote, and `verify-trip` is what
    // turns that into a visible `wrong-trip` rather than a wrong price — so
    // there is nothing to report from here and nothing to retry.
    return false;
  }
}

// Guarded so the module can be imported without running. A content script has
// a `location`; a test importing the functions above does not, and an
// unguarded top-level call made the whole file untestable — which is why its
// first draft shipped with both halves of the mechanism unpinned.
if (typeof location !== 'undefined') {
  clearStaleState(new URL(location.href), () => globalThis.localStorage);
}
