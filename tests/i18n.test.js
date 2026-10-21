// Every interface string exists in both languages. Run with: node tests/i18n.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { window: {}, navigator: { language: 'ru' }, localStorage: { getItem: () => null, setItem() {} }, document: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), ctx);
const { ru, en } = ctx.window.I18N.dict;
const problems = [];

for (const k of Object.keys(ru)) if (!(k in en)) problems.push('missing in en: ' + k);
for (const k of Object.keys(en)) if (!(k in ru)) problems.push('missing in ru: ' + k);

// Keys used in code: t('key'), data-i18n="key", and key-like string literals.
const used = new Set();
const prefixes = 'net|conn|err|game|durak|bs|chess|score|status|over|log|tag';
for (const f of fs.readdirSync(root)) {
  if (!/\.(js|html)$/.test(f) || f === 'i18n.js') continue;
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-ph)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(new RegExp("'((?:" + prefixes + ")\\.[\\w.]+)'", 'g'))) used.add(m[1]);
}
// Keys built at runtime.
for (const g of ['durak', 'battleship', 'chess']) used.add('game.' + g);
for (const c of ['over', 'bad', 'cantPlay', 'cantBeat', 'cantTransfer', 'cantTake', 'cantPass', 'notYourTurn', 'illegal', 'badFleet', 'alreadyShot']) used.add('err.' + c);
for (const b of ['out', 'taking', 'defending', 'attacking', 'passed']) used.add('durak.badge.' + b);
for (const r of ['mate', 'stalemate', 'resign', 'agreement', 'repetition', 'fifty', 'material']) used.add('chess.reason.' + r);
for (const p of 'qrbn') used.add('chess.piece.' + p);
used.add('kicked');
for (const k of used) if (!k.endsWith('.') && (!(k in ru) || !(k in en))) problems.push('used but not defined: ' + k);

// Every error code an engine can return has a message.
for (const f of ['durak.js', 'chess.js', 'battleship.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/return '(\w+)';/g)) if (!('err.' + m[1] in ru)) problems.push(f + ' returns ' + m[1] + ' without err.' + m[1]);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
console.log(process.exitCode ? 'i18n check failed' : 'i18n: ' + used.size + ' keys used, ' + Object.keys(ru).length + ' defined in both languages');
