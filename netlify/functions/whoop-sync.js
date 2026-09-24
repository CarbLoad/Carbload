// Called from the app (with the user's Supabase session token as a Bearer
// token) to pull recent Whoop data and write it into whoop_logs. Refreshes
// the stored Whoop access token first if it's expired or about to be.
//
// Note: Whoop's API has shifted field/endpoint names across versions in the
// past. If real responses come back shaped differently than expected here,
// the fix is almost always just adjusting the field names this function
// reads (e.g. score.recovery_score, score.strain) to match whatever Whoop's
// current developer docs show for your app's API version - the storage and
// auth plumbing around it won't need to change.
const { createClient } = require("@supabase/supabase-js");

// Whoop's cycle.start timestamp is anchored to roughly bedtime (a cycle
// runs from one night's sleep onset through the next), while a recovery
// record's created_at is anchored to wake time. For a UK user, bedtime
// often falls after midnight UTC but is still "today" in local time (UTC
// is an hour behind BST), so naively slicing the raw UTC ISO string's date
// puts the cycle/strain one calendar day earlier than the date Whoop's own
// app shows it under - while recovery, whose timestamp rarely sits that
// close to the UTC/local midnight boundary, usually lands on the right day
// by luck. Converting both through the user's actual local time zone (sent
// by the browser - see the ?tz= query param) fixes the cycle/strain shift
// without relying on that luck, and keeps recovery's bucketing exactly as
// correct as it already was.
function localDateFromIso(isoString, timeZone) {
  if (!isoString) return "";
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the bucket key this
    // file already uses everywhere else.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch (e) {
    // Unknown/invalid IANA zone name (e.g. a malformed query param) - fall
    // back to the old UTC-slice behavior rather than failing the sync.
    return isoString.slice(0, 10);
  }
}

async function refreshWhoopToken(admin, userId, tokenRow) {
  const refreshRes = await fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token,
      client_id: process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET
    })
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || !refreshData.access_token) return null;

  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString();
  await admin.from("oauth_tokens").update({
    access_token: refreshData.access_token,
    refresh_token: refreshData.refresh_token || tokenRow.refresh_token,
    expires_at: newExpiresAt
  }).eq("user_id", userId).eq("provider", "whoop");

  return refreshData.access_token;
}

exports.handler = async function (event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const jwt = authHeader && authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return { statusCode: 401, body: "Missing Authorization header" };

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, body: "Invalid or expired session" };
  }
  const userId = userData.user.id;
  // Sent by the browser as its own IANA zone (e.g. "Europe/London") - see
  // localDateFromIso above for why this matters. Falls back to UTC (the
  // old behavior) if the app is called without it for some reason.
  const timeZone = (event.queryStringParameters && event.queryStringParameters.tz) || "UTC";

  const { data: tokenRow } = await admin.from("oauth_tokens").select("*").eq("user_id", userId).eq("provider", "whoop").maybeSingle();
  if (!tokenRow) return { statusCode: 404, body: "Whoop is not connected for this account" };

  let accessToken = tokenRow.access_token;
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60000) {
    const refreshed = await refreshWhoopToken(admin, userId, tokenRow);
    if (!refreshed) return { statusCode: 401, body: "Whoop token refresh failed - please reconnect Whoop in Settings" };
    accessToken = refreshed;
  }

  try {
    // Explicitly ask for the last 30 days by date range rather than relying
    // on the API's documented-but-unreliable "newest first" default order -
    // in practice that default returned records from over a year ago, so a
    // date window is the only way to reliably get recent data.
    const now = new Date();
    const startWindow = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endWindow = now.toISOString();
    const rangeParams = "start=" + encodeURIComponent(startWindow) + "&end=" + encodeURIComponent(endWindow) + "&limit=25";

    const [recoveryRes, cyclesRes] = await Promise.all([
      fetch("https://api.prod.whoop.com/developer/v2/recovery?" + rangeParams, { headers: { Authorization: "Bearer " + accessToken } }),
      fetch("https://api.prod.whoop.com/developer/v2/cycle?" + rangeParams, { headers: { Authorization: "Bearer " + accessToken } })
    ]);
    if (!recoveryRes.ok || !cyclesRes.ok) {
      const status = !recoveryRes.ok ? recoveryRes.status : cyclesRes.status;
      console.error("Whoop API returned a non-OK status:", status);
      return { statusCode: 502, body: "Whoop's API returned an error (status " + status + ") - try reconnecting Whoop in Settings" };
    }
    const recoveryData = await recoveryRes.json();
    const cyclesData = await cyclesRes.json();
    console.log("Whoop sync: recovery records=" + (recoveryData.records || []).length + ", cycle records=" + (cyclesData.records || []).length);
    console.log("Whoop sync: first cycle raw =", JSON.stringify((cyclesData.records || [])[0] || null));
    console.log("Whoop sync: first recovery raw =", JSON.stringify((recoveryData.records || [])[0] || null));

    // Diagnostic only: also fetch without any date filter, purely to see
    // what the account's total unfiltered history looks like for
    // comparison - this doesn't affect what gets saved below.
    try {
      const [unfilteredRecRes, unfilteredCycRes] = await Promise.all([
        fetch("https://api.prod.whoop.com/developer/v2/recovery?limit=25", { headers: { Authorization: "Bearer " + accessToken } }),
        fetch("https://api.prod.whoop.com/developer/v2/cycle?limit=25", { headers: { Authorization: "Bearer " + accessToken } })
      ]);
      const unfilteredRec = await unfilteredRecRes.json();
      const unfilteredCyc = await unfilteredCycRes.json();
      console.log("Whoop sync (unfiltered): recovery count=" + (unfilteredRec.records || []).length + ", cycle count=" + (unfilteredCyc.records || []).length);
      console.log("Whoop sync (unfiltered): first cycle raw =", JSON.stringify((unfilteredCyc.records || [])[0] || null));
    } catch (diagErr) {
      console.warn("Whoop sync: unfiltered diagnostic call failed", diagErr);
    }

    const byDate = {};
    (recoveryData.records || []).forEach(function (r) {
      const date = localDateFromIso(r.created_at || r.updated_at, timeZone);
      if (!date) return;
      byDate[date] = byDate[date] || {};
      if (r.score) {
        byDate[date].recovery = r.score.recovery_score;
        byDate[date].hrv = r.score.hrv_rmssd_milli;
        byDate[date].restingHr = r.score.resting_heart_rate;
      }
    });
    (cyclesData.records || []).forEach(function (c) {
      const date = localDateFromIso(c.start, timeZone);
      if (!date) return;
      byDate[date] = byDate[date] || {};
      if (c.score) {
        byDate[date].strain = c.score.strain;
        byDate[date].whoopCalories = c.score.kilojoule != null ? Math.round(c.score.kilojoule / 4.184) : undefined;
      }
    });

    const rows = Object.keys(byDate).map(function (date) {
      const d = byDate[date];
      return {
        id: date,
        user_id: userId,
        date: date,
        recovery: d.recovery != null ? d.recovery : null,
        strain: d.strain != null ? d.strain : null,
        sleep_pct: null,
        hrv: d.hrv != null ? d.hrv : null,
        resting_hr: d.restingHr != null ? d.restingHr : null,
        whoop_calories: d.whoopCalories != null ? d.whoopCalories : null
      };
    });

    if (rows.length) {
      await admin.from("whoop_logs").upsert(rows);
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ synced: rows.length }) };
  } catch (e) {
    console.error("Whoop sync failed:", e);
    return { statusCode: 502, body: "Could not reach Whoop right now - try again shortly" };
  }
};
