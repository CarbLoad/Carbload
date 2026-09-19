// Called from the app (with the user's Supabase session token as a Bearer
// token) to pull recent Strava activities and write them into strava_logs.
// Refreshes the stored Strava access token first if needed - Strava's
// access tokens are short-lived (a few hours) so this runs on most syncs.
const { createClient } = require("@supabase/supabase-js");

async function refreshStravaToken(admin, userId, tokenRow) {
  const refreshRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token
    })
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || !refreshData.access_token) return null;

  const newExpiresAt = new Date((refreshData.expires_at || (Date.now() / 1000 + 21600)) * 1000).toISOString();
  await admin.from("oauth_tokens").update({
    access_token: refreshData.access_token,
    refresh_token: refreshData.refresh_token || tokenRow.refresh_token,
    expires_at: newExpiresAt
  }).eq("user_id", userId).eq("provider", "strava");

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

  const { data: tokenRow } = await admin.from("oauth_tokens").select("*").eq("user_id", userId).eq("provider", "strava").maybeSingle();
  if (!tokenRow) return { statusCode: 404, body: "Strava is not connected for this account" };

  let accessToken = tokenRow.access_token;
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60000) {
    const refreshed = await refreshStravaToken(admin, userId, tokenRow);
    if (!refreshed) return { statusCode: 401, body: "Strava token refresh failed - please reconnect Strava in Settings" };
    accessToken = refreshed;
  }

  try {
    const actRes = await fetch("https://www.strava.com/api/v3/athlete/activities?per_page=15", {
      headers: { Authorization: "Bearer " + accessToken }
    });
    const activities = await actRes.json();
    if (!Array.isArray(activities)) {
      return { statusCode: 502, body: "Unexpected response from Strava" };
    }

    // One row per day - but a day can have more than one activity (e.g. a
    // lifting session plus a rowing session), so rather than keeping only
    // the highest-effort activity and silently dropping the rest, combine
    // every same-day activity into a single row: distance/duration/effort/
    // calories are summed (two sessions are genuinely more total load than
    // either alone - the day-type and recovery-fueling logic downstream
    // wants that combined number), and the activity type becomes a
    // "+"-joined label (e.g. "WeightTraining + Rowing") so nothing is lost
    // from the summary either.
    const byDate = {};
    activities.forEach(function (a) {
      const date = ((a.start_date_local || a.start_date || "") + "").slice(0, 10);
      if (!date) return;
      const activityType = a.type || a.sport_type || "Activity";
      const distanceKm = a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null;
      const durationMin = a.moving_time ? Math.round(a.moving_time / 60) : null;
      const effort = a.suffer_score != null ? a.suffer_score : null;
      const calories = a.calories != null ? a.calories : null;

      if (!byDate[date]) {
        byDate[date] = {
          activityTypes: [activityType],
          distanceKm: distanceKm,
          durationMin: durationMin,
          relativeEffort: effort,
          calories: calories
        };
        return;
      }
      const d = byDate[date];
      d.activityTypes.push(activityType);
      if (distanceKm != null) d.distanceKm = (d.distanceKm || 0) + distanceKm;
      if (durationMin != null) d.durationMin = (d.durationMin || 0) + durationMin;
      if (effort != null) d.relativeEffort = (d.relativeEffort || 0) + effort;
      if (calories != null) d.calories = (d.calories || 0) + calories;
    });

    const rows = Object.keys(byDate).map(function (date) {
      const d = byDate[date];
      return {
        id: date,
        user_id: userId,
        date: date,
        activity_type: d.activityTypes.join(" + "),
        distance_km: d.distanceKm != null ? Math.round(d.distanceKm * 100) / 100 : null,
        duration_min: d.durationMin,
        relative_effort: d.relativeEffort,
        calories: d.calories
      };
    });

    if (rows.length) {
      await admin.from("strava_logs").upsert(rows);
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ synced: rows.length }) };
  } catch (e) {
    console.error("Strava sync failed:", e);
    return { statusCode: 502, body: "Could not reach Strava right now - try again shortly" };
  }
};
