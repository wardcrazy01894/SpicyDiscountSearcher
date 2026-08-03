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
 * Measured: clearing the store and re-opening the same URL changed the header
 * to "Tampa Intl Airport (TPA) - Select drop-off location" and left the prices
 * rendering. The site then re-populates the store from the URL rather than from
 * the stale copy.
 *
 * Runs at `document_start` — the whole point. The probe runs at `document_idle`,
 * which is long after the page has hydrated its store, so this cannot live
 * there. It is a separate, deliberately tiny script for that reason.
 *
 * Side effect worth knowing: this also clears the "recent searches" convenience
 * on the vendor's own site for the user's normal browsing. That is a cache, not
 * account data, and the alternative is quoting prices for a trip nobody asked
 * for.
 */

/** Per-host, because these keys are one vendor's implementation detail. */
const STALE_KEYS: Record<string, readonly string[]> = {
  'www.avis.com': ['booking-widget.store', 'recent-search-options', 'recent-location-options'],
};

function clearStaleState(): void {
  const keys = STALE_KEYS[location.host];
  if (!keys) return;
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable (partitioned, disabled, quota-evicted). A
      // failure here costs accuracy on this one quote, and the trip check in
      // the probe is what turns that into a visible failure rather than a
      // wrong price — so there is nothing to report and nothing to retry.
    }
  }
}

clearStaleState();
