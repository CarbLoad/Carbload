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

  const { data: tokenRow } = await admin.from("oauth_tokens").select("*").eq("user_id", userId).eq("provider", "whoop").maybeSingle();
  if (!tokenRow) return { statusCode: 404, body: "Whoop is not connected for this account" };

  let accessToken = tokenRow.access_token;
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60000) {
    const refreshed = await refreshWhoopToken(admin, userId, tokenRow);
    if (!refreshed) return { statusCode: 401, body: "Whoop token refresh failed - please reconnect Whoop in Settings" };
    accessToken = refreshed;
  }

  try {
    const [recoveryRes, cyclesRes] = await Promise.all([
      fetch("https://api.prod.whoop.com/developer/v2/recovery?limit=10", { headers: { Authorization: "Bearer " + accessToken } }),
      fetch("https://api.prod.whoop.com/developer/v2/cycle?limit=10", { headers: { Authorization: "Bearer " + accessToken } })
    ]);
    if (!recoveryRes.ok || !cyclesRes.ok) {
      const status = !recoveryRes.ok ? recoveryRes.status : cyclesRes.status;
      console.error("Whoop API returned a non-OK status:", status);
      return { statusCode: 502, body: "Whoop's API returned an error (status " + status + ") - try reconnecting Whoop in Settings" };
    }
    const recoveryData = await recoveryRes.json();
    const cyclesData = await cyclesRes.json();

    const byDate = {};
    (recoveryData.records || []).forEach(function (r) {
      const date = ((r.created_at || r.updated_at || "") + "").slice(0, 10);
      if (!date) return;
      byDate[date] = byDate[date] || {};
      if (r.score) {
        byDate[date].recovery = r.score.recovery_score;
        byDate[date].hrv = r.score.hrv_rmssd_milli;
        byDate[date].restingHr = r.score.resting_heart_rate;
      }
    });
    (cyclesData.records || []).forEach(function (c) {
      const date = ((c.start || "") + "").slice(0, 10);
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
