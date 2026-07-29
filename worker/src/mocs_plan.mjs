// MOCS Local Law 63 plans are deliberately disabled.
//
// The former runtime ID (egea-b8r5) is a non-tabular Socrata link asset, while the
// former documented ID (whpb-ebtd) does not exist. MOCS currently publishes rotating
// per-agency spreadsheets from an HTML page, without a stable machine manifest. Until
// that publication satisfies data/source_contracts.json, the daily job only removes
// plan rows left by earlier deployments. No upstream request is made and no new plan
// forecast can enter the product.

const PLAN_PREFIX = "plan:";

export async function runMocsPlanPipeline(env) {
  if (!env.ALERT_STATE?.list || !env.ALERT_STATE?.delete) {
    return { status: "disabled", removed: 0 };
  }

  let cursor;
  let removed = 0;
  do {
    const page = await env.ALERT_STATE.list({
      prefix: PLAN_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page?.keys || []) {
      await env.ALERT_STATE.delete(key.name);
      removed++;
    }
    cursor = page?.list_complete === false ? page.cursor : null;
  } while (cursor);

  return { status: "disabled", removed };
}
