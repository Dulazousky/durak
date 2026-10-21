// Small DOM and storage helpers shared by the app and the game screens.
(() => {
  'use strict';

  const $ = (s, root) => (root || document).querySelector(s);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  function randomId(len, chars) {
    chars = chars || 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (const x of buf) s += chars[x % chars.length];
    return s;
  }

  // h('div', {class, text, onclick, ...attrs}, ...children). Text always goes
  // through textContent, so player names and chat can't inject markup.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  window.UI = { $, h, store, randomId, toast };
  window.GAMES = {};
})();
