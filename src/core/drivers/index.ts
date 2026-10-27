import type { FormDriverRegistry } from '../form-driver.js';
import { enterpriseDriver } from './enterprise.js';
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
 * `enterpriseDriver` joined on 2026-08-12, once its calendar and time dropdowns
 * were measured and driven. It was held out while `applyDates` threw
 * unconditionally, because registering it then would have routed runs to a
 * driver that could not express the trip's dates.
 */
export const FORM_DRIVERS: FormDriverRegistry = {
  enterprise: enterpriseDriver,
  national: nationalDriver,
};
