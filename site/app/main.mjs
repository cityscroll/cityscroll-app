await import("./core.mjs");
await import("./money-list.mjs");
await import("./money-history.mjs");
await import("./search-share.mjs");
await import("./people.mjs");
await import("./land.mjs");
await import("./feed-actions.mjs");
await import("./property.mjs");
await import("./rules.mjs");
await import("./alerts.mjs");
await import("./procurement-lifecycle.mjs");
await import("./procurement-phase.mjs");
await import("./subsidy.mjs");
await import("./meetings.mjs");
await import("./entities.mjs");
await import("./workspace.mjs");
await import("./map.mjs");
await import("./routing.mjs");
await import("./boot.mjs");

// The original parser-blocking inline script created its dynamic controls before deferred
// privacy instrumentation ran. Module loading is deferred, so re-apply the same form mask after
// boot to preserve that ordering guarantee.
globalThis.CROLClarity?.applyInputMasking(document);
