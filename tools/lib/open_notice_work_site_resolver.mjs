// Offline address-to-district resolver for the open-notice work-site reader.
//
// Chains the engine's committed snapshots; nothing here touches the network:
//   address text  -> parseAddressQuery / addressShardKey / resolveAddressFromShard
//                    (NYC DCP Property Address Directory snapshot, site/data/address-index)
//   BBL           -> lookupParcelPoint (MapPLUTO tax-lot point, site/data/parcel-geography)
//   point         -> resolveContractPlaceAssertion's point containment against the community-district
//                    boundary layer (full-fidelity polygons, data/geography/layers)
// Build and acquisition path only, never a resident read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addressShardKey,
  parseAddressQuery,
  resolveAddressFromShard,
} from "../../site/precomputed_address_geocoder.mjs";
import { lookupParcelPoint, parcelShardKey } from "../../site/parcel_geography.mjs";
import { loadCivicGeographyLayer } from "../../site/civic_geography.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../../site/geography_navigation_capability.mjs";
import { OPEN_NOTICE_WORK_SITE_SOURCE } from "../../site/open_notice_work_site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relative, root) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

/** Load the navigation boundary layers at full fidelity from the committed registry. */
export function loadFullBoundaryLayers({ root = ROOT } = {}) {
  const registry = readJson("site/data/geography/layer_registry.json", root);
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => {
    const row = registry.layers.find((entry) => entry.type === type);
    if (!row) throw new Error(`boundary layer ${type} is not in the registry`);
    return loadCivicGeographyLayer(readJson(row.artifacts.full.path, root));
  });
}

/**
 * Synchronous committed-snapshot geocoder with the contract the work-site reader injects:
 * `{ status: "matched", bbl, zip, borough, lon, lat, ... }`, `{ status: "ambiguous" }` or
 * `{ status: "unknown", reason }`. Never invents a point: a BBL without a published tax-lot
 * point is unknown, not a borough centre.
 */
export function createCommittedAddressGeocoder({ root = ROOT } = {}) {
  const manifest = readJson("site/data/address-index/manifest.json", root);
  const parcelManifest = readJson("site/data/parcel-geography/manifest.json", root);
  const addressShards = new Map();
  const parcelShards = new Map();

  function addressShard(key) {
    if (!addressShards.has(key)) {
      const descriptor = manifest.shards?.[key];
      addressShards.set(key, descriptor?.file
        ? readJson(path.join("site/data/address-index", descriptor.file), root)
        : null);
    }
    return addressShards.get(key);
  }

  function parcelShard(key) {
    if (!parcelShards.has(key)) {
      try {
        parcelShards.set(key, readJson(`site/data/parcel-geography/${key}.json`, root));
      } catch {
        parcelShards.set(key, null);
      }
    }
    return parcelShards.get(key);
  }

  function geocode(addressText) {
    const query = parseAddressQuery(addressText);
    if (query.status === "not_full_address") return { status: "unknown", reason: "not_full_address" };
    const shard = addressShard(addressShardKey(query.street, manifest.shard_count));
    const hit = resolveAddressFromShard(query, shard, manifest);
    if (hit.status !== "matched") {
      if (hit.reason === "ambiguous") {
        return { status: "ambiguous", reason: "ambiguous_address", candidate_count: hit.candidate_count ?? null };
      }
      return { status: "unknown", reason: hit.reason || "not_covered" };
    }
    const point = lookupParcelPoint(parcelShard(parcelShardKey(hit.bbl)), hit.bbl);
    if (!point) return { status: "unknown", reason: "parcel_point_unavailable", bbl: hit.bbl };
    return {
      status: "matched",
      bbl: hit.bbl,
      zip: hit.zip,
      borough: hit.borough,
      lon: point.lon,
      lat: point.lat,
      method: hit.method,
      source_version: hit.source_version,
      data_as_of: hit.data_as_of,
    };
  }

  geocode.sources = Object.freeze({
    address: {
      name: manifest.source?.name || "NYC Department of City Planning Property Address Directory",
      dataset_id: manifest.source?.dataset_id || null,
      version: manifest.source?.version || null,
      generated_at: manifest.generated_at || null,
    },
    parcel_point: {
      method: parcelManifest.point_method || null,
      coordinate_vintage: parcelManifest.coordinate_vintage || null,
      generated_at: parcelManifest.generated_at || null,
    },
  });
  return geocode;
}

/** The resolver record the artifact publishes, so a reader can see which snapshots answered. */
export function workSiteResolverSources({ geocode, layerData }) {
  const layer = (layerData || []).find((entry) => entry?.type === "community_district") || null;
  return {
    source: OPEN_NOTICE_WORK_SITE_SOURCE,
    ...geocode.sources,
    boundary: {
      type: "community_district",
      vintage: layer?.vintage?.id || null,
      geometry_fidelity: "full",
    },
  };
}
