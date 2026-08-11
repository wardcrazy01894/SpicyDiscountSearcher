import type { FormDriverRegistry } from '../form-driver.js';
import { nationalDriver } from './national.js';

/**
 * Vendors whose form the probe will drive.
 *
 * Its own module because a driver imports `form-driver.ts` for `DriverError` and
 * the helpers, so keeping the registry there and importing the drivers back
 * would be a cycle.
 *
 * **Registration is not the same as enabling, in either direction.** A vendor
 * reaches a driver only if it is also `searchable: true` *and* its builder
 * returns a URL — `unsearchable()` throws, `makeQuote` catches, and the quote is
 * settled at plan time before any lane sees it. National satisfies all three.
 *
 * `enterpriseDriver` is deliberately absent. Its `applyDates` is unimplemented
 * and always throws, so registering it would route runs to a driver that cannot
 * express the trip's dates. It joins the day that function is measured and
 * driven, in the same change.
 */
export const FORM_DRIVERS: FormDriverRegistry = {
  national: nationalDriver,
};
