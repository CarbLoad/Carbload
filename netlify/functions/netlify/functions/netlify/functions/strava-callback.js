// Step 2 of the Strava connection - see whoop-callback.js for the pattern
// this mirrors.
const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const userId = params.state;

  if (!code || !userId) {
    return { statusCode: 302, headers: { Location: "https://carbload.app/?strava=error" } };
  }

  let tokenData;
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code"
      })
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) throw new Error("Token exchange failed");
  } catch (e) {
    console.error("Strava token exchange failed:", e);
    return { statusCode: 302, headers: { Location: "https://carbload.app/?strava=error" } };
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const expiresAt = new Date((tokenData.expires_at || (Date.now() / 1000 + 21600)) * 1000).toISOString();
  await admin.from("oauth_tokens").upsert({
    user_id: userId,
    provider: "strava",
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    expires_at: expiresAt
  });

  return { statusCode: 302, headers: { Location: "https://carbload.app/?strava=connected" } };
};
