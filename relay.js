// Backup channel for when two browsers can't connect directly (WebRTC fails
// on many mobile and home networks). Messages go through free public MQTT
// brokers over secure WebSockets instead. Nobody has to set anything up.
//
// The brokers are public, so everything is end-to-end encrypted with AES-GCM
// under a key derived from the room code, and the topic name is a hash of the
// code, not the code itself.
//
// Window.Relay.host(code, onConnection) listens for guests; Relay.join(code)
// connects to the host. Both hand out connection objects that look like a
// PeerJS DataConnection: open, send(msg), close(), on('open'|'data'|'close').
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  // ?relay=ws://host:port points at a local broker for testing.
  const BROKERS = params.get('relay') ? [params.get('relay')] : [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const PING_MS = 5000;
  const DEAD_MS = 20000;
  const supported = !!(window.WebSocket && window.crypto && crypto.subtle && window.TextEncoder);

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---- a minimal MQTT 3.1.1 client: connect, subscribe, QoS 0 publish ----

  function varint(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 128;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function str(s) {
    const b = enc.encode(s);
    return [b.length >> 8, b.length & 255, ...b];
  }

  function packet(first, body) {
    const out = new Uint8Array(1 + varint(body.length).length + body.length);
    const len = varint(body.length);
    out[0] = first;
    out.set(len, 1);
    out.set(body, 1 + len.length);
    return out;
  }

  class Mqtt {
    constructor(url) {
      this.url = url;
      this.handlers = new Map(); // topic -> fn(bytes)
      this.buf = new Uint8Array(0);
      this.ready = false;
      this.closed = false;
      this.onclose = null;
    }

    connect(timeoutMs) {
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { reject(e); return; }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => { reject(new Error('timeout')); this.close(); }, timeoutMs);
        ws.onopen = () => {
          const id = 'gn' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
          // "MQTT", level 4, clean session, keep-alive 30 s, client id.
          ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 30, ...str(id)]));
        };
        ws.onmessage = (e) => this.feed(new Uint8Array(e.data), () => { clearTimeout(timer); resolve(this); });
        ws.onerror = () => {};
        ws.onclose = () => {
          clearTimeout(timer);
          if (!this.ready) reject(new Error('closed'));
          this.ready = false;
          clearInterval(this.pinger);
          if (!this.closed && this.onclose) this.onclose();
          this.closed = true;
        };
      });
    }

    // Split the byte stream into MQTT packets.
    feed(bytes, onConnack) {
      const all = new Uint8Array(this.buf.length + bytes.length);
      all.set(this.buf);
      all.set(bytes, this.buf.length);
      let pos = 0;
      for (;;) {
        if (all.length - pos < 2) break;
        let len = 0;
        let mul = 1;
        let i = pos + 1;
        let done = false;
        while (i < all.length && i < pos + 5) {
          const b = all[i++];
          len += (b & 127) * mul;
          mul *= 128;
          if (!(b & 128)) { done = true; break; }
        }
        if (!done || all.length < i + len) break;
        this.handle(all[pos] >> 4, all.subarray(i, i + len), onConnack);
        pos = i + len;
      }
      this.buf = all.slice(pos);
    }

    handle(type, body, onConnack) {
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { this.close(); return; }
        this.ready = true;
        this.pinger = setInterval(() => this.raw(new Uint8Array([0xc0, 0])), 20000);
        onConnack();
      } else if (type === 3) { // PUBLISH (QoS 0)
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const fn = this.handlers.get(topic);
        if (fn) fn(body.slice(2 + tlen));
      }
    }

    raw(bytes) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
    }

    // Handlers run one at a time, in arrival order, even when they await.
    subscribe(topic, fn) {
      let queue = Promise.resolve();
      this.handlers.set(topic, (bytes) => { queue = queue.then(() => fn(bytes)).catch(() => {}); });
      this.pid = ((this.pid || 0) % 65535) + 1;
      this.raw(packet(0x82, [this.pid >> 8, this.pid & 255, ...str(topic), 0]));
    }

    publish(topic, payload) {
      const t = str(topic);
      const body = new Uint8Array(t.length + payload.length);
      body.set(t);
      body.set(payload, t.length);
      this.raw(packet(0x30, body));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.pinger);
      try { this.raw(new Uint8Array([0xe0, 0])); this.ws.close(); } catch (e) { /* already gone */ }
    }
  }

  // ---- encryption and naming ----

  async function sha256(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  }
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  async function roomSecrets(code) {
    const key = await crypto.subtle.importKey('raw', await sha256('game-night relay key ' + code), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const base = 'gamenight/v1/' + hex(await sha256('game-night relay topic ' + code)).slice(0, 32);
    return {
      toHost: base + '/h',
      toGuest: (rid) => base + '/g/' + rid,
      async seal(obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
        const out = new Uint8Array(12 + ct.length);
        out.set(iv);
        out.set(ct, 12);
        return out;
      },
      async open(bytes) {
        try {
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
          return JSON.parse(dec.decode(pt));
        } catch (e) {
          return null; // someone else's traffic, or garbage
        }
      },
    };
  }

  // ---- connection objects ----

  class RelayConn {
    constructor(sendFn, closeFn) {
      this.open = false;
      this.relay = true;
      this.listeners = {};
      this.sendFn = sendFn;
      this.closeFn = closeFn;
      this.lastHeard = Date.now();
      this.queue = Promise.resolve();
    }
    // Encryption is async; keep outgoing messages in order.
    post(obj) { this.queue = this.queue.then(() => this.sendFn(obj)).catch(() => {}); }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    emit(ev, arg) { for (const fn of this.listeners[ev] || []) fn(arg); }
    send(msg) { if (this.open) this.post({ k: 'msg', d: msg }); }
    markOpen() { if (this.open) return; this.open = true; this.emit('open'); }
    close() {
      if (this.done) return;
      this.done = true;
      const was = this.open;
      this.open = false;
      clearInterval(this.timer);
      this.queue.then(() => this.closeFn(was));
      this.emit('close');
    }
    // Keep-alive both ways; silence means the other side is gone.
    watch() {
      this.timer = setInterval(() => {
        if (Date.now() - this.lastHeard > DEAD_MS) this.close();
        else this.post({ k: 'ping' });
      }, PING_MS);
    }
  }

  // ---- host side ----

  // Listens on every broker it can reach, so a guest finds it on whichever
  // broker the guest manages to use. Returns {close(), up()}.
  async function host(code, onConnection, onChange) {
    if (!supported) return null;
    const sec = await roomSecrets(code);
    const clients = [];
    const guests = new Map(); // rid -> RelayConn
    let stopped = false;

    function attach(client) {
      client.subscribe(sec.toHost, async (bytes) => {
        const m = await sec.open(bytes);
        if (!m || typeof m.f !== 'string' || !/^[a-z0-9]{8,32}$/.test(m.f)) return;
        let c = guests.get(m.f);
        if (m.k === 'hello') {
          // A new guest, or one retrying: (re)acknowledge on this broker.
          if (!c || c.done) {
            const rid = m.f;
            c = new RelayConn(
              async (obj) => client.ready && client.publish(sec.toGuest(rid), await sec.seal(Object.assign({ f: 'host' }, obj))),
              async (was) => { guests.delete(rid); if (was && client.ready) client.publish(sec.toGuest(rid), await sec.seal({ f: 'host', k: 'bye' })); });
            guests.set(rid, c);
            onConnection(c);
            c.watch();
          }
          c.lastHeard = Date.now();
          client.publish(sec.toGuest(m.f), await sec.seal({ f: 'host', k: 'welcome' }));
          c.markOpen();
          return;
        }
        if (!c) return;
        c.lastHeard = Date.now();
        if (m.k === 'msg') c.emit('data', m.d);
        else if (m.k === 'bye') c.close();
      });
    }

    async function connectAll() {
      await Promise.all(BROKERS.map(async (url) => {
        if (stopped || clients.some((x) => x.url === url && x.ready)) return;
        const client = new Mqtt(url);
        try {
          await client.connect(8000);
        } catch (e) {
          return;
        }
        if (stopped) { client.close(); return; }
        const i = clients.findIndex((x) => x.url === url);
        if (i >= 0) clients.splice(i, 1);
        clients.push(client);
        attach(client);
        if (onChange) onChange();
        client.onclose = () => { if (onChange && !stopped) onChange(); if (!stopped) setTimeout(connectAll, 3000); };
      }));
    }
    connectAll();
    const retry = setInterval(() => { if (!stopped && !clients.some((x) => x.ready)) connectAll(); }, 15000);

    return {
      up: () => clients.some((x) => x.ready),
      close() {
        stopped = true;
        clearInterval(retry);
        for (const c of guests.values()) c.close();
        setTimeout(() => clients.forEach((x) => x.close()), 300);
      },
    };
  }

  // ---- guest side ----

  // Resolves with an open RelayConn, or null if no broker reached the host.
  async function join(code) {
    if (!supported) return null;
    const sec = await roomSecrets(code);
    const rid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => (x % 36).toString(36)).join('');
    for (const url of BROKERS) {
      const client = new Mqtt(url);
      try {
        await client.connect(8000);
      } catch (e) {
        continue;
      }
      const conn = new RelayConn(
        async (obj) => client.ready && client.publish(sec.toHost, await sec.seal(Object.assign({ f: rid }, obj))),
        async (was) => {
          if (was && client.ready) client.publish(sec.toHost, await sec.seal({ f: rid, k: 'bye' }));
          setTimeout(() => client.close(), 300);
        });
      const welcomed = new Promise((resolve) => {
        client.subscribe(sec.toGuest(rid), async (bytes) => {
          const m = await sec.open(bytes);
          if (!m || m.f !== 'host') return;
          conn.lastHeard = Date.now();
          if (m.k === 'welcome') resolve(true);
          else if (m.k === 'msg') conn.emit('data', m.d);
          else if (m.k === 'bye') conn.close();
        });
      });
      client.onclose = () => conn.close();
      // Say hello a few times: the subscription needs a moment to settle.
      let tries = 0;
      const hello = async () => { if (!conn.open && tries++ < 4) client.publish(sec.toHost, await sec.seal({ f: rid, k: 'hello' })); };
      hello();
      const nudger = setInterval(hello, 1500);
      const ok = await Promise.race([welcomed, new Promise((r) => setTimeout(() => r(false), 7000))]);
      clearInterval(nudger);
      if (ok) {
        conn.watch();
        conn.markOpen();
        return conn;
      }
      client.onclose = null;
      client.close();
    }
    return null;
  }

  window.Relay = { supported, host, join, BROKERS };
})();
