'use strict';

// Genkender knapperne på en rigtig fjernbetjening, mens Homey lytter i baggrunden.
// Hvert modtaget frame dekodes (lib/decode.js) til protokol + bit + nøgle, og den id sammenlignes
// med de id'er, knapperne ville give. En knaps id'er findes ved at sende dens kode gennem en
// simuleret modtagelse – så virker det også for RAW-koder og for protokoller, der er ens på
// luften (Holtek_HT12X/CAME), fordi knappen så får den id, Homey faktisk hører.

const { encode } = require('./protocols');
const { decodeFrame } = require('./decode');
const { merge } = require('./raw');

const RX_MIN = 433760000; // Homey modtager kun 433,76–434,08 MHz
const RX_MAX = 434080000;
const GAP_MS = 700; // pause uden frames, før næste tryk på samme knap tælles som et nyt
const MIN_FRAMES = 2; // frames med samme kode, før et tryk tælles (så ét fejlafkodet frame ikke udløser)

const idOf = (r) => `${r.protocol}|${r.bits}|${r.key}`;

// Signerede µs (én gentagelse) -> frames som Homey modtager dem: [puls, pause]-par, delt ved lange
// pauser, hvor parret før pausen tabes. words: rx-tabellens ord (tiderne afrundes til nærmeste).
// jitter() (valgfri, til test) giver en faktor pr. tid, fx 1 ± 10 %.
function onAir(frame, words, jitter = () => 1) {
  const seq = [];
  for (let r = 0; r < 4; r++) seq.push(...frame, -9000); // pause mellem gentagelserne
  const s = merge(seq);
  if (!s.some((v) => v > 0)) return [];
  while (s[0] < 0) s.push(s.shift());
  const frames = [];
  let cur = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    const h = s[i] * jitter();
    const l = -s[i + 1] * jitter();
    if (h > 4500 || l > 5000) {
      if (cur.length >= 6) frames.push(cur);
      cur = [];
      continue;
    }
    let best = [h, l];
    if (words) {
      let be = Infinity;
      for (const w of words) {
        const e = Math.abs(Math.log(h / w[0])) + Math.abs(Math.log(l / w[1]));
        if (e < be) { be = e; best = w; }
      }
    }
    cur.push(best);
  }
  return frames;
}

// Kode fra en knap -> de id'er, Homey kan høre den som ([] = kan ikke genkendes).
// tables: ordlisterne fra rx-signalerne i app.json.
function matchIds(code, tables = [null]) {
  if (!code) return [];
  const f = Number(code.frequency) || 433920000;
  if (f < RX_MIN || f > RX_MAX) return [];
  let frame;
  try {
    frame = code.pulses ? code.pulses : encode(code).frame;
  } catch (e) {
    return [];
  }
  const ids = new Set();
  for (const words of tables) {
    const count = new Map();
    for (const pairs of onAir(frame, words)) {
      const r = decodeFrame(pairs);
      if (r) count.set(idOf(r), (count.get(idOf(r)) || 0) + 1);
    }
    for (const [id, n] of count) if (n >= MIN_FRAMES) ids.add(id);
  }
  // Kodens egen id med, hvis den kan høres overhovedet (fx ikke Linear, hvor Homey taber en bit).
  if (ids.size && !code.pulses) ids.add(idOf(code));
  return [...ids];
}

// Holder styr på, hvilke knapper der lyttes efter, og samler frames til tryk.
// targets: [{ ids: [...], target }]; frame(result, now, source) -> targets, der skal udløses nu.
// Homey giver hvert frame én gang pr. rx-tabel, så frames tælles pr. kilde (source = signal-id);
// ellers ville ét frame hørt i begge tabeller tælle som to.
class Matcher {
  constructor({ gapMs = GAP_MS, minFrames = MIN_FRAMES } = {}) {
    this.gapMs = gapMs;
    this.minFrames = minFrames;
    this._byId = new Map();
    this._state = new Map();
  }

  get size() {
    return this._byId.size;
  }

  setTargets(list) {
    this._byId = new Map();
    for (const { ids, target } of list) {
      for (const id of ids) {
        if (!this._byId.has(id)) this._byId.set(id, []);
        this._byId.get(id).push(target);
      }
    }
    for (const id of this._state.keys()) if (!this._byId.has(id)) this._state.delete(id);
  }

  frame(result, now, source = '') {
    if (!result) return [];
    const id = idOf(result);
    const targets = this._byId.get(id);
    if (!targets) return [];
    let s = this._state.get(id);
    if (!s || now - s.last > this.gapMs) s = { count: new Map(), fired: false };
    const n = (s.count.get(source) || 0) + 1;
    s.count.set(source, n);
    s.last = now;
    this._state.set(id, s);
    if (s.fired || n < this.minFrames) return [];
    s.fired = true;
    return targets;
  }
}

module.exports = {
  matchIds, onAir, idOf, Matcher, GAP_MS, MIN_FRAMES,
};
