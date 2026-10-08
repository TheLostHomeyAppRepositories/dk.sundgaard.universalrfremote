'use strict';

const { err } = require('./i18n');

// Finder én ren gentagelse i en Flipper RAW-optagelse.
// En optagelse indeholder typisk støj + mange gentagelser adskilt af lange pauser.

function merge(values) {
  const out = [];
  for (const v of values) {
    if (!v) continue;
    const last = out[out.length - 1];
    if (last !== undefined && Math.sign(last) === Math.sign(v)) out[out.length - 1] += v;
    else out.push(v);
  }
  return out;
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// -> { frame: signerede µs (starter høj, slutter med pausen), copies: antal fundne gentagelser }
function extractRepetition(raw) {
  const p = merge(raw);
  while (p.length && p[0] < 0) p.shift();
  if (p.length < 4) throw err('raw_short');

  const lows = p.filter((v) => v < 0).map((v) => -v);
  const threshold = Math.max(3000, median(lows) * 6);

  // Del op efter lange pauser; pausen hører til segmentet før.
  const segments = [];
  let cur = [];
  for (const v of p) {
    cur.push(v);
    if (v < 0 && -v >= threshold) { segments.push(cur); cur = []; }
  }
  if (cur.length) segments.push(cur);

  const useful = segments.filter((s) => s.length >= 8);
  if (!useful.length) throw err('raw_nothing');

  // Det hyppigste antal pulser er signalet; resten er støj eller afbrudte gentagelser.
  const byLen = new Map();
  for (const s of useful) byLen.set(s.length, (byLen.get(s.length) || 0) + 1);
  let bestLen = 0;
  let bestCount = 0;
  for (const [len, count] of byLen) {
    if (count > bestCount || (count === bestCount && len > bestLen)) { bestLen = len; bestCount = count; }
  }
  const same = useful.filter((s) => s.length === bestLen);
  // Element-vis median giver et robust frame uden enkeltudsving.
  const frame = [];
  for (let i = 0; i < bestLen; i++) {
    const sign = Math.sign(same[0][i]);
    frame.push(sign * median(same.map((s) => Math.abs(s[i]))));
  }
  if (frame[frame.length - 1] > 0) frame.push(-10000); // sidste segment uden pause
  return { frame, copies: same.length };
}

module.exports = { extractRepetition, merge, median };
