/**
 * RUM bootstrap.
 *
 * The test-only helper still requires an explicit testOnly capability. The
 * production helper is a no-op unless the generated manifest is enabled, the
 * page is on a canonical production host, and a release identity exists.
 * Both paths wait for load and an idle task before importing collector code.
 */

function afterLoad(runtime, callback) {
  if (!runtime?.document || runtime.document.readyState === "complete") {
    callback();
    return;
  }
  if (typeof runtime.addEventListener === "function") {
    runtime.addEventListener("load", callback, { once: true });
  } else {
    callback();
  }
}

function whenIdle(runtime, callback) {
  if (typeof runtime?.requestIdleCallback === "function") {
    runtime.requestIdleCallback(callback, { timeout: 1000 });
    return;
  }
  const schedule = runtime?.setTimeout || globalThis.setTimeout;
  schedule(callback, 0);
}

async function loadManifest(runtime) {
  const response = await runtime.fetch("/data/performance-classification-manifest.v1.json", {
    cache: "force-cache",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("performance classification manifest unavailable");
  return response.json();
}

export function scheduleProductionRumCollector({
  runtime = globalThis,
  manifest,
  manifestLoader = () => loadManifest(runtime),
  releaseLoader,
  importCollector = () => import("./rum_collector.mjs"),
  importWebVitals = () => import("./vendor/web-vitals-6.0.1.mjs"),
  importDelivery = () => import("./rum_delivery.mjs"),
  importProduction = () => import("./rum_production.mjs"),
  importMilestones = () => import("./rum_semantic_milestones.mjs"),
} = {}) {
  return new Promise((resolve) => {
    afterLoad(runtime, () => {
      whenIdle(runtime, async () => {
        try {
          const production = await importProduction();
          const hostname = runtime?.location?.hostname || "";
          if (!production.isRumProductionHost(hostname)) {
            resolve({ state: "non_production" });
            return;
          }
          const [
            collector,
            webVitals,
            delivery,
            milestones,
            loadedManifest,
            releaseId,
          ] = await Promise.all([
            importCollector(),
            importWebVitals(),
            importDelivery(),
            importMilestones(),
            manifest === undefined ? manifestLoader() : manifest,
            production.loadRumReleaseId(runtime, { releaseLoader }),
          ]);
          if (loadedManifest?.collector?.production_enabled !== true) {
            resolve({ state: "disabled" });
            return;
          }
          if (!releaseId) {
            resolve({ state: "unavailable" });
            return;
          }
          const classification = collector.classifyPerformancePathname(
            loadedManifest,
            runtime?.location?.pathname || "",
          );
          const sink = production.createProductionObservationSink({
            manifest: loadedManifest,
            classification,
            releaseId,
            deviceClass: collector.coarseDeviceClass?.(
              runtime,
              loadedManifest.collector?.device_classes,
            ),
            deliver(batch) {
              return delivery.deliverRumBatch(batch, {
                enabled: true,
                developerToken: production.developerExclusionToken(runtime),
                runtime,
              });
            },
          });
          const rum = milestones.createRumSemanticMilestones({
            enabled: true,
            record: (record) => sink.record(record),
          });
          try {
            runtime.CROLRumSemanticMilestones = rum;
            runtime.CROL_RUM_SEMANTIC_MILESTONES = rum;
            runtime.CROLRumSemanticBuffer?.drain?.(rum);
          } catch {
            // Installing the reporter must never become a page error.
          }
          const started = await collector.startBrowserRumCollector({
            production: true,
            manifest: loadedManifest,
            pathname: runtime?.location?.pathname,
            runtime,
            sink,
            webVitals,
          });
          const flush = () => { void sink.flush(); };
          if (typeof runtime?.addEventListener === "function") {
            runtime.addEventListener("pagehide", flush);
            runtime.addEventListener("visibilitychange", () => {
              if (runtime?.document?.visibilityState === "hidden") flush();
            });
          }
          resolve({ ...started, state: started.state, sink });
        } catch {
          resolve({ state: "unavailable" });
        }
      });
    });
  });
}

export function scheduleTestOnlyRumCollector({
  testOnly = false,
  runtime = globalThis,
  manifest,
  manifestLoader = () => loadManifest(runtime),
  sink,
  importCollector = () => import("./rum_collector.mjs"),
  importWebVitals = () => import("./vendor/web-vitals-6.0.1.mjs"),
} = {}) {
  if (testOnly !== true) return Promise.resolve({ state: "disabled" });

  return new Promise((resolve) => {
    afterLoad(runtime, () => {
      whenIdle(runtime, async () => {
        try {
          const [collector, webVitals, loadedManifest] = await Promise.all([
            importCollector(),
            importWebVitals(),
            manifest === undefined ? manifestLoader() : manifest,
          ]);
          const debugSink = sink || collector.createLocalRumDebugSink();
          resolve(await collector.startBrowserRumCollector({
            testOnly: true,
            manifest: loadedManifest,
            pathname: runtime?.location?.pathname,
            runtime,
            sink: debugSink,
            webVitals,
          }));
        } catch {
          resolve({ state: "unavailable" });
        }
      });
    });
  });
}
