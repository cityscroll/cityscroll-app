// The provider's daily usage includes inbound mail and all sending paths.
export function providerDailyQuota(report) {
  const daily = report?.emails?.daily;
  if (!Number.isSafeInteger(daily?.used) || daily.used < 0
      || !(daily.limit === null || (Number.isSafeInteger(daily.limit) && daily.limit > 0))
      || !Number.isFinite(Date.parse(daily.resets_at))) throw new Error("Invalid provider daily quota");
  const { used, limit, resets_at } = daily;
  let status = "ok";
  if (limit === null) status = "uncapped";
  else if (used >= limit) status = "exhausted";
  else if (used * 100 >= limit * 80) status = "warning";
  return { status, used, limit, resets_at };
}

export async function readProviderDailyQuota(env) {
  const res = await fetch("https://api.resend.com/usage", {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    signal: AbortSignal.timeout(8000),
    // Workers returns redirects to the caller in manual mode. The status
    // check below refuses them before credentials can reach another origin.
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`Provider usage HTTP ${res.status}`);
  return providerDailyQuota(await res.json());
}
