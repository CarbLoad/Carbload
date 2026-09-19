// Step 1 of the Strava connection - see whoop-authorize.js for the pattern
// this mirrors.
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

  const redirectUri = "https://carbload.app/.netlify/functions/strava-callback";
  const authUrl =
    "https://www.strava.com/oauth/authorize" +
    "?client_id=" + encodeURIComponent(process.env.STRAVA_CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&response_type=code" +
    "&approval_prompt=auto" +
    "&scope=" + encodeURIComponent("read,activity:read_all") +
    "&state=" + encodeURIComponent(data.user.id);

  return { statusCode: 302, headers: { Location: authUrl } };
};
