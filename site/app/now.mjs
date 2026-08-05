let nowViewPromise = null;

function loadNowView() {
  if (!nowViewPromise) nowViewPromise = import("../now_view.mjs");
  return nowViewPromise;
}

async function showNow(options = {}) {
  const view = await loadNowView();
  return view.showNow(options);
}

globalThis.showNow = showNow;
