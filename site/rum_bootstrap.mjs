/**
 * Disabled/test-only RUM bootstrap.
 *
 * Production HTML does not load this module. Even an explicit test harness
 * must wait until the page load event and an idle task before the collector,
 * manifest, or locally hosted web-vitals bundle is requested.
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
