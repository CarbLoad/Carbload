// Step 2 of the Whoop connection: Whoop redirects here with a one-time
// `code` after the user approves access. This exchanges that code for an
// access/refresh token pair (using the client secret, which never reaches
// the browser) and stores it against the user id we passed through as
// `state` in whoop-authorize.js.
const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const userId = params.state;

  if (!code || !userId) {
    return { statusCode: 302, headers: { Location: "https://carbload.app/?whoop=error" } };
  }

  const redirectUri = "https://carbload.app/.netlify/functions/whoop-callback";

  let tokenData;
  try {
    const tokenRes = await fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        redirect_uri: redirectUri
      })
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) throw new Error("Token exchange failed");
  } catch (e) {
    console.error("Whoop token exchange failed:", e);
    return { statusCode: 302, headers: { Location: "https://carbload.app/?whoop=error" } };
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
  await admin.from("oauth_tokens").upsert({
    user_id: userId,
    provider: "whoop",
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    expires_at: expiresAt
  });

  return { statusCode: 302, headers: { Location: "https://carbload.app/?whoop=connected" } };
};
