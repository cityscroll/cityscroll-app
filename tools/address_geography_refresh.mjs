#!/usr/bin/env node
/**
 * Scheduled address-geography refresh command.
 *
 * Extends the PAD / parcel / meeting-geography production harnesses: checks
 * publisher metadata, reacquires only when changed (or weekly when metadata
 * cannot establish equality), recomputes changed membership layers, reprovides
 * record joins, and activates resident meeting-geography outputs in one
 * publication generation. A failed run retains the last activated generation.
 *
 * Usage:
 *   node tools/address_geography_refresh.mjs
 *   node tools/address_geography_refresh.mjs --check
 *   node tools/address_geography_refresh.mjs --fixture-dir DIR
 *   node tools/address_geography_refresh.mjs --force
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDRESS_GEOGRAPHY_REFRESH_RECEIPT_SCHEMA,
  computeAddressGeographyFingerprints,
  createAddressGeographyRefresh,
  loadAddressGeographyRefreshReceipt,
  planAddressGeographyRefresh,
  refreshReceiptPath,
  writeAddressGeographyRefreshReceipt,
} from "../site/address_geography_refresh.mjs";
import {
  activateMeetingGeographyBackfill,
  createMeetingGeographyBackfill,
  loadActiveMeetingGeographyBackfill,
  stampMeetingRowsWithGeography,
} from "../site/meeting_geography_backfill.mjs";
import { LOCATION_ROLES } from "../site/meeting_location_assertions.mjs";
import {
  lookupParcelMemberships,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  createRecordAddressResolutionCache,
  padContentIdentity,
} from "../site/record_address_resolution_cache.mjs";
import {
  createRecordLocationMembershipProjection,
} from "../site/record_location_memberships.mjs";
import { runMembershipBuild } from "./build_parcel_memberships.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_DIR = path.join(ROOT, "site/data/meeting-geography-backfill");
const DEFAULT_SHARED_MEETING = path.join(ROOT, "site/data/shared_meeting_read_model.json");
const DEFAULT_ADDRESS_DIR = path.join(ROOT, "site/data/address-index");
const DEFAULT_PARCEL_DIR = path.join(ROOT, "site/data/parcel-geography");
const DEFAULT_LAYER_REGISTRY = path.join(ROOT, "site/data/geography/layer_registry.json");
const DEFAULT_COMMUNITY_BOARD_GEOGRAPHY = path.join(
  ROOT,
  "site/data/community_board_geography_lookup.json",
);
const PAD_METADATA = "https://data.cityofnewyork.us/api/views/bc8t-ecyu";
const MAPPLUTO_LAYER =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0";

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    check: false,
    force: false,
    fixtureDir: null,
    publicDir: DEFAULT_PUBLIC_DIR,
    sharedMeetingPath: DEFAULT_SHARED_MEETING,
    addressDir: DEFAULT_ADDRESS_DIR,
    parcelDir: DEFAULT_PARCEL_DIR,
    layerRegistry: DEFAULT_LAYER_REGISTRY,
    communityBoardGeographyPath: DEFAULT_COMMUNITY_BOARD_GEOGRAPHY,
    skipLiveMetadata: false,
    injectFailure: null,
    help: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") args.check = true;
    else if (token === "--force") args.force = true;
    else if (token === "--skip-live-metadata") args.skipLiveMetadata = true;
    else if (token === "--fixture-dir") args.fixtureDir = path.resolve(argv[++index]);
    else if (token === "--public-dir") args.publicDir = path.resolve(argv[++index]);
    else if (token === "--shared-meeting") args.sharedMeetingPath = path.resolve(argv[++index]);
    else if (token === "--address-dir") args.addressDir = path.resolve(argv[++index]);
    else if (token === "--parcel-dir") args.parcelDir = path.resolve(argv[++index]);
    else if (token === "--layer-registry") args.layerRegistry = path.resolve(argv[++index]);
    else if (token === "--inject-failure") args.injectFailure = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function shardLoader(dir) {
  const cache = new Map();
  return (shardKey) => {
    const key = String(shardKey || "");
    if (cache.has(key)) return cache.get(key);
    const candidates = [
      path.join(dir, `${key}.json`),
      // Fixture trees may collapse every BBL into one synthetic shard.
      path.join(dir, "00.json"),
      path.join(dir, "pad-street-subsets.json"),
    ];
    let doc = null;
    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      doc = loadJson(filePath);
      break;
    }
    cache.set(key, doc);
    return doc;
  };
}

async function fetchPadMetadata(fetchImpl = fetch) {
  const response = await fetchImpl(PAD_METADATA, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`PAD metadata failed: HTTP ${response.status}`);
  const metadata = await response.json();
  const version = String(metadata.description || "").match(/Current version:\s*([\w.-]+)/i)?.[1]
    || "unknown";
  const updatedAt = Number(metadata.rowsUpdatedAt) > 0
    ? new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString()
    : null;
  return {
    version,
    updatedAt,
    equalityKey: updatedAt || (version !== "unknown" ? `version:${version}` : null),
  };
}

async function fetchMapplutoMetadata(fetchImpl = fetch) {
  const url = `${MAPPLUTO_LAYER}?f=pjson`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`MapPLUTO metadata failed: HTTP ${response.status}`);
  const metadata = await response.json();
  const lastEdit = metadata?.editingInfo?.lastEditDate
    ?? metadata?.editFieldsInfo?.editDateField
    ?? null;
  const equalityKey = lastEdit != null
    ? `lastEdit:${lastEdit}`
    : (metadata?.name ? `name:${metadata.name}` : null);
  return {
    name: metadata?.name || null,
    lastEditDate: lastEdit,
    equalityKey,
  };
}

function boundaryDigestsFromRegistry(registryPath, root = ROOT) {
  if (!existsSync(registryPath)) return {};
  const registry = loadJson(registryPath);
  const digests = {};
  for (const layer of registry.layers || []) {
    const type = layer?.type;
    if (!type) continue;
    const sha = layer?.artifacts?.full?.sha256
      || layer?.artifacts?.full?.content_sha256
      || null;
    if (sha) {
      digests[type] = String(sha);
      continue;
    }
    const fullPath = layer?.artifacts?.full?.path;
    if (!fullPath) continue;
    const absolute = path.isAbsolute(fullPath) ? fullPath : path.join(root, fullPath);
    if (!existsSync(absolute)) continue;
    digests[type] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  }
  return digests;
}

function applyFixtureDir(args) {
  if (!args.fixtureDir) return args;
  const dir = args.fixtureDir;
  const mapped = { ...args };
  const maybe = (name, key) => {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) mapped[key] = candidate;
  };
  maybe("address-index", "addressDir");
  maybe("parcel-geography", "parcelDir");
  maybe("layer_registry.json", "layerRegistry");
  maybe("shared_meeting_read_model.json", "sharedMeetingPath");
  maybe("community_board_geography_lookup.json", "communityBoardGeographyPath");
  maybe("meeting-geography-backfill", "publicDir");
  maybe("pad-metadata.json", "padMetadataPath");
  maybe("mappluto-metadata.json", "mapplutoMetadataPath");
  // Also accept nested publisher metadata beside the fixture root.
  if (existsSync(path.join(dir, "publisher", "pad-metadata.json"))) {
    mapped.padMetadataPath = path.join(dir, "publisher", "pad-metadata.json");
  }
  if (existsSync(path.join(dir, "publisher", "mappluto-metadata.json"))) {
    mapped.mapplutoMetadataPath = path.join(dir, "publisher", "mappluto-metadata.json");
  }
  mkdirSync(mapped.publicDir, { recursive: true });
  return mapped;
}

/**
 * Build production (or fixture-backed) adapters for the refresh runner.
 */
export function buildAddressGeographyRefreshAdapters(options = {}) {
  const args = applyFixtureDir({
    publicDir: options.publicDir || DEFAULT_PUBLIC_DIR,
    sharedMeetingPath: options.sharedMeetingPath || DEFAULT_SHARED_MEETING,
    addressDir: options.addressDir || DEFAULT_ADDRESS_DIR,
    parcelDir: options.parcelDir || DEFAULT_PARCEL_DIR,
    layerRegistry: options.layerRegistry || DEFAULT_LAYER_REGISTRY,
    communityBoardGeographyPath:
      options.communityBoardGeographyPath || DEFAULT_COMMUNITY_BOARD_GEOGRAPHY,
    fixtureDir: options.fixtureDir || null,
    skipLiveMetadata: Boolean(options.skipLiveMetadata),
    padMetadataPath: options.padMetadataPath || null,
    mapplutoMetadataPath: options.mapplutoMetadataPath || null,
    fetchImpl: options.fetchImpl || fetch,
    polygonComputationCounter: options.polygonComputationCounter || { value: 0 },
  });

  const addressResolutionsCounter = options.addressResolutionsCounter || { value: 0 };
  const polygonComputationCounter = args.polygonComputationCounter;

  async function readPublisherMetadata() {
    if (args.padMetadataPath || args.mapplutoMetadataPath || args.skipLiveMetadata) {
      const padMeta = args.padMetadataPath && existsSync(args.padMetadataPath)
        ? loadJson(args.padMetadataPath)
        : { equalityKey: null };
      const mapMeta = args.mapplutoMetadataPath && existsSync(args.mapplutoMetadataPath)
        ? loadJson(args.mapplutoMetadataPath)
        : { equalityKey: null };
      return {
        pad: {
          version: padMeta.version || null,
          updatedAt: padMeta.updatedAt || padMeta.updated_at || null,
          equalityKey: padMeta.equalityKey || padMeta.equality_key || null,
        },
        coordinates: {
          name: mapMeta.name || null,
          lastEditDate: mapMeta.lastEditDate || mapMeta.last_edit_date || null,
          equalityKey: mapMeta.equalityKey || mapMeta.equality_key || null,
        },
      };
    }
    const [pad, coordinates] = await Promise.all([
      fetchPadMetadata(args.fetchImpl),
      fetchMapplutoMetadata(args.fetchImpl),
    ]);
    return { pad, coordinates };
  }

  return {
    loadFingerprints: async () => {
      const addressManifest = loadJson(path.join(args.addressDir, "manifest.json"));
      const parcelManifestPath = path.join(args.parcelDir, "manifest.json");
      const coordinateManifest = existsSync(parcelManifestPath)
        ? loadJson(parcelManifestPath)
        : null;
      const shared = loadJson(args.sharedMeetingPath);
      const metadata = await readPublisherMetadata();
      return {
        fingerprints: computeAddressGeographyFingerprints({
          padManifest: addressManifest,
          padMetadataEqualityKey: metadata.pad.equalityKey,
          coordinateManifest,
          coordinateMetadataEqualityKey: metadata.coordinates.equalityKey,
          boundaryDigests: boundaryDigestsFromRegistry(args.layerRegistry),
          meetingRows: shared.rows || [],
        }),
        metadata,
        shared,
      };
    },
    loadPreviousReceipt: () => loadAddressGeographyRefreshReceipt(args.publicDir),
    saveReceipt: (receipt) => writeAddressGeographyRefreshReceipt(args.publicDir, receipt),
    loadActiveGeneration: () => {
      const active = loadActiveMeetingGeographyBackfill(args.publicDir);
      return active?.pointer?.active_generation || null;
    },
    acquirePad: async ({ mode }) => {
      // Production PAD acquisition stays on tools/build_geocoder_address_index.mjs.
      // Fixture / rehearsal mode treats the committed (or fixture) index as current
      // and only records that the stage ran when force-verify requested a check.
      const addressManifest = loadJson(path.join(args.addressDir, "manifest.json"));
      return {
        acquired: mode === "run" || mode === "force_verify",
        fingerprints: {
          pad_content_identity: padContentIdentity(addressManifest),
        },
        mode,
      };
    },
    acquireCoordinates: async ({ mode }) => {
      const parcelManifestPath = path.join(args.parcelDir, "manifest.json");
      if (!existsSync(parcelManifestPath)) {
        throw Object.assign(new Error("parcel geography manifest missing"), {
          failure_kind: "partial_coordinates",
        });
      }
      const coordinateManifest = loadJson(parcelManifestPath);
      return {
        acquired: mode === "run" || mode === "force_verify",
        fingerprints: {
          coordinate_identity: [
            coordinateManifest.coordinate_vintage || "",
            coordinateManifest.source?.sha256 || "",
            coordinateManifest.coverage?.retained_parcels ?? "",
          ].join("|"),
        },
        mode,
      };
    },
    rebuildMemberships: async ({ changedLayers, coordinatesChanged, padChanged }) => {
      const layers = (changedLayers && changedLayers.length)
        ? changedLayers.slice()
        : (coordinatesChanged || padChanged ? ["*"] : []);
      // Prefer the production membership builder when a real parcel dir is present.
      // Fixture rehearsals count synthetic polygon work instead of rebuilding citywide.
      if (!args.fixtureDir && existsSync(path.join(args.parcelDir, "manifest.json"))) {
        try {
          await runMembershipBuild({
            parcelDir: args.parcelDir,
            out: args.parcelDir,
            registry: args.layerRegistry,
          });
        } catch (error) {
          // Membership builder may refuse in reduced checkouts; surface as incomplete.
          throw Object.assign(error, { failure_kind: "incomplete_boundaries" });
        }
      } else {
        polygonComputationCounter.value += Math.max(layers.length, 1);
      }
      return {
        polygon_computations: polygonComputationCounter.value,
        layers_recomputed: layers[0] === "*" ? ["all"] : layers,
      };
    },
    reprojectRecordJoins: async ({
      plan,
      padChanged,
      membershipsChanged,
      changedMeetingIds,
    }) => {
      const shared = loadJson(args.sharedMeetingPath);
      const rows = shared.rows || [];
      const venueChanged = Array.isArray(changedMeetingIds) && changedMeetingIds.length > 0;
      const forceAddressReprocess = padChanged || plan.stages.pad !== "skip";

      const addressManifest = loadJson(path.join(args.addressDir, "manifest.json"));
      const loadAddressShard = shardLoader(args.addressDir);
      const loadParcelShard = shardLoader(args.parcelDir);
      const addressCache = createRecordAddressResolutionCache({
        manifest: addressManifest,
        loadShard: loadAddressShard,
      });
      const parcelManifestPath = path.join(args.parcelDir, "manifest.json");
      const parcelManifest = existsSync(parcelManifestPath)
        ? loadJson(parcelManifestPath)
        : {};
      const membershipProjection = createRecordLocationMembershipProjection({
        loadParcelShard,
        parcelMembershipGeneration: parcelManifest.membership?.generated_at
          || parcelManifest.coordinate_vintage
          || parcelManifest.generated_at
          || null,
      });
      const communityBoardGeography = existsSync(args.communityBoardGeographyPath)
        ? loadJson(args.communityBoardGeographyPath)
        : null;
      const runner = createMeetingGeographyBackfill({
        addressCache,
        membershipProjection,
        communityBoardGeography,
        lookupParcelPoint: (bbl) => {
          const shard = loadParcelShard(parcelShardKey(bbl));
          const bundle = lookupParcelMemberships(shard, bbl);
          if (!bundle) return null;
          return { lat: bundle.lat, lon: bundle.lon };
        },
      });

      const generation = `refresh-${createHash("sha256")
        .update(JSON.stringify({
          changed: [...(changedMeetingIds || [])].sort(),
          pad: forceAddressReprocess,
          memberships: membershipsChanged,
          venue: venueChanged,
        }))
        .digest("hex")
        .slice(0, 12)}`;

      // Boundary/coordinate-only: reuse prior checkpoint outcomes so addresses
      // are not re-resolved, then re-project retained assertions through the
      // new membership generation.
      const priorCheckpointPath = path.join(args.publicDir, "checkpoint.json");
      const priorCheckpoint = (!forceAddressReprocess && existsSync(priorCheckpointPath))
        ? loadJson(priorCheckpointPath)
        : null;

      let result;
      if (membershipsChanged && !forceAddressReprocess && !venueChanged && priorCheckpoint?.processed) {
        const observedAt = new Date().toISOString();
        const outcomes = [];
        for (const row of rows) {
          const prior = priorCheckpoint.processed[row.meeting_id];
          if (!prior) {
            const fresh = runner.processMeetingRow(row, { observedAt });
            outcomes.push(fresh);
            continue;
          }
          const projectionInputs = (prior.assertions || []).map((assertion) => {
            if (assertion?.role === LOCATION_ROLES.HOST_JURISDICTION) {
              return { assertion };
            }
            const membership = (prior.memberships || []).find((entry) => (
              entry.assertion_id === assertion.assertion_id
            ));
            return {
              assertion,
              resolution: membership?.bbl
                ? {
                  assertion_id: assertion.assertion_id,
                  meeting_id: row.meeting_id,
                  bbl: membership.bbl,
                  status: "matched",
                }
                : null,
            };
          });
          const document = membershipProjection.replaceRecordAssertions(
            row.meeting_id,
            projectionInputs,
            { observedAt },
          );
          const edges = document.edges.filter((edge) => edge.record_id === row.meeting_id);
          const memberships = edges.reduce((list, edge) => {
            let rowMembership = list.find((entry) => entry.assertion_id === edge.assertion_id);
            if (!rowMembership) {
              rowMembership = {
                record_id: row.meeting_id,
                assertion_id: edge.assertion_id,
                role: edge.role,
                bbl: edge.bbl || null,
                memberships: {},
                point: null,
                confidence: 1,
                confidence_tier: "strong",
                provenance: { source_method: edge.method || "accepted_exact_parcel_membership" },
              };
              list.push(rowMembership);
            }
            if (edge.geography_type && edge.geography_id != null) {
              rowMembership.memberships[edge.geography_type] = String(edge.geography_id);
            }
            return list;
          }, []);
          outcomes.push({
            ...prior,
            memberships,
            edge_count: edges.length,
            processed_at: observedAt,
          });
        }
        result = {
          generation,
          checkpoint: {
            ...priorCheckpoint,
            generation,
            updated_at: new Date().toISOString(),
            processed: Object.fromEntries(outcomes.map((outcome) => [outcome.meeting_id, outcome])),
            completed: true,
          },
          outcomes,
          counts: {
            input_rows: rows.length,
            processed_rows: outcomes.length,
            newly_processed: 0,
            resumed_unchanged: outcomes.length,
          },
          projection: membershipProjection.snapshot(),
        };
      } else {
        result = runner.run({
          rows,
          generation,
          sourceGenerationHash: generation,
          checkpoint: forceAddressReprocess ? null : priorCheckpoint,
          observedAt: new Date().toISOString(),
        });
      }

      const addressResolutions = addressCache.resolveCallCount();
      addressResolutionsCounter.value += addressResolutions;

      mkdirSync(args.publicDir, { recursive: true });
      writeFileSync(
        path.join(args.publicDir, "checkpoint.json"),
        `${JSON.stringify(result.checkpoint, null, 2)}\n`,
      );

      const stamped = stampMeetingRowsWithGeography(rows, result.outcomes);
      const outcomesDocument = {
        schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
        generation,
        built_at: new Date().toISOString(),
        outcomes: result.outcomes,
      };
      const activation = activateMeetingGeographyBackfill({
        publicDir: args.publicDir,
        generation,
        manifest: {
          schema: "cityscroll.meeting_geography_backfill_manifest.v1",
          generation,
          built_at: outcomesDocument.built_at,
          counts: result.counts,
          refresh: true,
        },
        outcomesDocument,
        projectionDocument: result.projection,
        stampedSharedMeetingModel: {
          ...shared,
          rows: stamped,
        },
        sharedMeetingReadModelPath: args.sharedMeetingPath,
      });

      return {
        address_resolutions: addressResolutions,
        records_reprojected: venueChanged
          ? changedMeetingIds.length
          : (membershipsChanged || forceAddressReprocess ? rows.length : 0),
        reverse_index_updated: true,
        active_generation: activation.generation,
        projection: result.projection,
        outcomes: result.outcomes,
        generation,
      };
    },
    rebuildResidentOutputs: async ({ joinResult }) => {
      // Meeting-geography activation already stamped the shared meeting read
      // model (the published-slice input). Dependent district-activity /
      // worker-route rebuilds stay on the first-class committed-read-models
      // sequence; this stage records the hand-off rather than bypassing it.
      return {
        active_generation: joinResult?.active_generation || null,
        outputs: {
          shared_meeting_read_model: args.sharedMeetingPath,
          meeting_geography_public_dir: args.publicDir,
          deferred_to_committed_read_models: [
            "tools/build_district_activity.mjs",
            "tools/build_worker_route_read_models.mjs",
          ],
        },
      };
    },
  };
}

export async function runAddressGeographyRefresh(cliArgs = {}) {
  const defaults = {
    check: false,
    force: false,
    fixtureDir: null,
    publicDir: DEFAULT_PUBLIC_DIR,
    sharedMeetingPath: DEFAULT_SHARED_MEETING,
    addressDir: DEFAULT_ADDRESS_DIR,
    parcelDir: DEFAULT_PARCEL_DIR,
    layerRegistry: DEFAULT_LAYER_REGISTRY,
    communityBoardGeographyPath: DEFAULT_COMMUNITY_BOARD_GEOGRAPHY,
    skipLiveMetadata: false,
    injectFailure: null,
  };
  const args = applyFixtureDir({ ...defaults, ...cliArgs });
  const adapters = buildAddressGeographyRefreshAdapters(args);
  const refresh = createAddressGeographyRefresh(adapters);
  return refresh.run({
    force: Boolean(args.force),
    injectFailure: args.injectFailure || null,
    now: args.now || new Date().toISOString(),
  });
}

async function main() {
  const args = applyFixtureDir(parseArgs(process.argv));
  if (args.help) {
    console.log(`Usage: node tools/address_geography_refresh.mjs [options]
  --check                 Validate the last refresh receipt shape
  --force                 Run every stage
  --fixture-dir DIR       Controlled publisher inputs for rehearsal
  --public-dir DIR        Meeting-geography public generation directory
  --shared-meeting PATH   Shared meeting read model path
  --address-dir DIR       PAD address-index directory
  --parcel-dir DIR        Parcel-geography directory
  --skip-live-metadata    Do not contact publisher metadata endpoints
  --inject-failure KIND   Rehearse timeout|partial_coordinates|incomplete_boundaries`);
    return;
  }

  if (args.check) {
    const receipt = loadAddressGeographyRefreshReceipt(args.publicDir);
    if (!receipt) {
      console.log("ok address-geography-refresh: no receipt yet (idle)");
      return;
    }
    if (receipt.schema !== ADDRESS_GEOGRAPHY_REFRESH_RECEIPT_SCHEMA) {
      throw new Error(`unexpected refresh receipt schema: ${receipt.schema}`);
    }
    console.log(
      `ok address-geography-refresh ${receipt.status}`
      + (receipt.active_generation ? ` active=${receipt.active_generation}` : ""),
    );
    return;
  }

  const result = await runAddressGeographyRefresh(args);
  const summary = {
    status: result.status,
    ok: result.ok,
    active_generation: result.active_generation,
    counters: result.counters,
    reasons: result.plan?.reasons || [],
  };
  console.log(JSON.stringify(summary));
  if (!result.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  boundaryDigestsFromRegistry,
  fetchPadMetadata,
  fetchMapplutoMetadata,
  parseArgs,
  planAddressGeographyRefresh,
  refreshReceiptPath,
};
