/**
 * The one precomputed address geocoder instance the browser routes share.
 *
 * Address-to-parcel resolution is not a Land-lens concern: the notice detail's
 * parcel links and the rules route's demolition check both need it on routes
 * that never open the Land list. Owning the instance here keeps a single
 * snapshot cache behind all three callers and keeps the geocoder off the Land
 * module's activation gate.
 */
import { createPrecomputedAddressGeocoder } from "./precomputed_address_geocoder.mjs";

const geocodeAddress = createPrecomputedAddressGeocoder();

/** Resolve one free-text address against the precomputed snapshot. */
export function geocodeAddressText(query) {
  return geocodeAddress(query);
}
