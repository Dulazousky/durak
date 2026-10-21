// Vercel serverless function: GET /api/ice -> { iceServers, provider }.
//
// Hands the browser short-lived credentials for a TURN relay, which carries
// the game traffic when two players' networks can't connect directly. The
// account keys stay in Vercel's environment variables, never in this public
// repository. Set one of:
//
//   Cloudflare:  CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
//   Metered:     METERED_DOMAIN (e.g. yourapp.metered.live) + METERED_API_KEY
//
// With neither set it returns an empty list and the game uses the shared relay.
'use strict';

async function cloudflare(keyId, token) {
  const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  // Newer responses list servers; older ones gave a single object.
  if (Array.isArray(j.iceServers)) return j.iceServers;
  return j.iceServers ? [j.iceServers] : null;
}

async function metered(domain, key) {
  const host = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const r = await fetch('https://' + host + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(key));
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) ? j : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const env = process.env;
  let iceServers = null;
  let provider = null;
  try {
    if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
      iceServers = await cloudflare(env.CLOUDFLARE_TURN_KEY_ID, env.CLOUDFLARE_TURN_API_TOKEN);
      if (iceServers) provider = 'cloudflare';
    }
    if (!iceServers && env.METERED_DOMAIN && env.METERED_API_KEY) {
      iceServers = await metered(env.METERED_DOMAIN, env.METERED_API_KEY);
      if (iceServers) provider = 'metered';
    }
  } catch (e) {
    iceServers = null;
  }
  res.status(200).json({ iceServers: iceServers || [], provider });
};
