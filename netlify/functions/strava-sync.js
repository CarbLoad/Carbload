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
    const summaryActivities = await actRes.json();
    if (!Array.isArray(summaryActivities)) {
      return { statusCode: 502, body: "Unexpected response from Strava" };
    }

    // The list endpoint above only returns Strava's "SummaryActivity" shape,
    // which never includes calories at all (for any activity type - that's
    // why every row, weight training included, was coming through blank) -
    // calories only exist on the per-activity "DetailedActivity" returned by
    // GET /activities/{id}, which is what the Strava app itself is reading
    // when it shows a calorie figure. So each activity needs one extra call
    // to actually get that number. Capped at the same 15 activities already
    // fetched above, well inside Strava's rate limits; a failed detail
    // fetch for one activity just falls back to its summary fields rather
    // than failing the whole sync.
    const activities = await Promise.all(summaryActivities.map(async function (a) {
      try {
        const detailRes = await fetch("https://www.strava.com/api/v3/activities/" + a.id, {
          headers: { Authorization: "Bearer " + accessToken }
        });
        if (!detailRes.ok) return a;
        const detail = await detailRes.json();
        return Object.assign({}, a, detail);
      } catch (detailErr) {
        console.warn("Strava sync: detail fetch failed for activity " + a.id, detailErr);
        return a;
      }
    }));

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

      // Strava's moving_time excludes whatever it judges to be "stopped"
      // time, based on a GPS/speed stream - correct for filtering out
      // traffic-light stops on an outdoor ride or run. An indoor rower has
      // no GPS: its "speed" is derived stroke by stroke, and the near-zero
      // speed during each stroke's recovery phase gets misread as
      // "stopped", which is how a real 30/60-minute row ends up synced as
      // a 1-3 minute one. Weight-training sessions weren't affected
      // because they never had a speed stream to auto-pause against in
      // the first place, so moving_time was already just elapsed time for
      // those. elapsed_time (total wall-clock duration) is the right
      // number for any activity with no meaningful "stopped" state -
      // Strava's own "trainer" flag marks indoor/stationary sessions, and
      // Rowing is included explicitly since indoor-rower syncs don't
      // always set that flag.
      const isStationary = a.trainer || activityType === "Rowing";
      const durationSeconds = isStationary ? (a.elapsed_time || a.moving_time) : (a.moving_time || a.elapsed_time);
      const distanceKm = a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null;
      const durationMin = durationSeconds ? Math.round(durationSeconds / 60) : null;
      const effort = a.suffer_score != null ? a.suffer_score : null;
      let calories = a.calories != null ? a.calories : null;
      // Strava only has calories to report when the activity carried heart
      // rate or power data - an erg session with neither (common: no HR
      // strap, no separate power meter) comes back with calories = null,
      // which isn't a sync bug, just missing source data. Concept2's own
      // published estimate (kcal/hr ~= watts*4 + 300) fills that gap when
      // the rowing computer at least reported average power, rather than
      // leaving the field blank; it never overrides a real Strava number.
      if (calories == null && activityType === "Rowing" && a.average_watts != null && durationSeconds) {
        calories = Math.round((a.average_watts * 4 + 300) * (durationSeconds / 3600));
      }
      const avgHr = a.average_heartrate != null ? a.average_heartrate : null;

      if (!byDate[date]) {
        byDate[date] = {
          activityTypes: [activityType],
          distanceKm: distanceKm,
          durationMin: durationMin,
          relativeEffort: effort,
          calories: calories,
          // Weighted by each activity's own duration so a longer, easier
          // session doesn't get out-voted by a short, spiky one when a day
          // has more than one activity - kept as running totals here and
          // divided out below once every activity's been folded in.
          hrWeightedSum: avgHr != null && durationSeconds ? avgHr * durationSeconds : 0,
          hrWeightSeconds: avgHr != null && durationSeconds ? durationSeconds : 0
        };
        return;
      }
      const d = byDate[date];
      d.activityTypes.push(activityType);
      if (distanceKm != null) d.distanceKm = (d.distanceKm || 0) + distanceKm;
      if (durationMin != null) d.durationMin = (d.durationMin || 0) + durationMin;
      if (effort != null) d.relativeEffort = (d.relativeEffort || 0) + effort;
      if (calories != null) d.calories = (d.calories || 0) + calories;
      if (avgHr != null && durationSeconds) {
        d.hrWeightedSum += avgHr * durationSeconds;
        d.hrWeightSeconds += durationSeconds;
      }
    });

    const rows = Object.keys(byDate).map(function (date) {
      const d = byDate[date];
      const avgHeartRate = d.hrWeightSeconds ? Math.round(d.hrWeightedSum / d.hrWeightSeconds) : null;
      return {
        id: date,
        user_id: userId,
        date: date,
        avg_heart_rate: avgHeartRate,
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
