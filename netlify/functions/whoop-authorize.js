// Step 1 of the Whoop connection: verifies the CarbLoad user making the
// request (via their Supabase session token) and redirects them to Whoop's
// own login/consent screen. Whoop sends them back to whoop-callback.js
// once they approve, carrying the CarbLoad user id in `state` so the
// callback knows whose account to attach the connection to.
const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  const accessToken = event.queryStringParameters && event.queryStringParameters.access_token;
  if (!accessToken) {
    return { statusCode: 400, body: "Missing access_token" };
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data || !data.user) {
    return { statusCode: 401, body: "Invalid or expired session - please log in again." };
  }

  const redirectUri = "https://carbload.app/.netlify/functions/whoop-callback";
  const scope = "read:recovery read:sleep read:workout read:cycles read:profile offline";
  const authUrl =
    "https://api.prod.whoop.com/oauth/oauth2/auth" +
    "?response_type=code" +
    "&client_id=" + encodeURIComponent(process.env.WHOOP_CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(scope) +
    "&state=" + encodeURIComponent(data.user.id);

  return { statusCode: 302, headers: { Location: authUrl } };
};
