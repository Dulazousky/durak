// The relay-credentials function, with the providers' APIs faked.
// Run with: node tests/ice.test.js
'use strict';
const assert = require('assert');
const handler = require('../api/ice.js');

function fakeRes() {
  return {
    headers: {}, code: 0, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function call(env, fetchImpl) {
  const saved = { env: process.env, fetch: global.fetch };
  process.env = env;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
  try {
    const res = fakeRes();
    await handler({}, res);
    return { res, calls };
  } finally {
    process.env = saved.env;
    global.fetch = saved.fetch;
  }
}

const ok = (body) => ({ ok: true, json: async () => body });
const TURN = { urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' };

(async () => {
  // Nothing configured: empty list, no outside calls.
  let r = await call({}, () => { throw new Error('should not fetch'); });
  assert.deepStrictEqual(r.res.body, { iceServers: [], provider: null });
  assert.strictEqual(r.res.headers['Cache-Control'], 'no-store');
  assert.strictEqual(r.calls.length, 0);

  // Cloudflare, both response shapes.
  r = await call({ CLOUDFLARE_TURN_KEY_ID: 'kid', CLOUDFLARE_TURN_API_TOKEN: 'tok' }, () => ok({ iceServers: [TURN] }));
  assert.deepStrictEqual(r.res.body, { iceServers: [TURN], provider: 'cloudflare' });
  assert.strictEqual(r.calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers');
  assert.strictEqual(r.calls[0].opts.headers.Authorization, 'Bearer tok');
  r = await call({ CLOUDFLARE_TURN_KEY_ID: 'kid', CLOUDFLARE_TURN_API_TOKEN: 'tok' }, () => ok({ iceServers: TURN }));
  assert.deepStrictEqual(r.res.body.iceServers, [TURN]);

  // Metered, with a pasted URL as the domain.
  r = await call({ METERED_DOMAIN: 'https://game.metered.live/', METERED_API_KEY: 'k&y' }, () => ok([TURN]));
  assert.deepStrictEqual(r.res.body, { iceServers: [TURN], provider: 'metered' });
  assert.strictEqual(r.calls[0].url, 'https://game.metered.live/api/v1/turn/credentials?apiKey=k%26y');

  // A failing provider falls back to the other, and errors never break the page.
  r = await call({ CLOUDFLARE_TURN_KEY_ID: 'kid', CLOUDFLARE_TURN_API_TOKEN: 'bad', METERED_DOMAIN: 'g.metered.live', METERED_API_KEY: 'k' },
    (url) => (url.includes('cloudflare') ? { ok: false } : ok([TURN])));
  assert.strictEqual(r.res.body.provider, 'metered');
  r = await call({ METERED_DOMAIN: 'g.metered.live', METERED_API_KEY: 'k' }, () => { throw new Error('network down'); });
  assert.deepStrictEqual(r.res.body, { iceServers: [], provider: null });

  console.log('ice: relay credentials function OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
