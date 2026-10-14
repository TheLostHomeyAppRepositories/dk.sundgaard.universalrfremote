'use strict';

const { err, msg, num } = require('./i18n');

// Oversætter pulser til Homeys 433 MHz-signaler.
// Homey kan kun sende via signaler, der er defineret i app.json: et signal har "ord" ([puls, pause] i µs),
// og et frame er en liste af ord-numre. Derfor genererer scripts/build-signals.js et katalog:
//   p_<protokol>_<kHz>  – præcise ord for hver protokol med faste tider
//   te<TE>_<kHz>        – ord for protokollerne med TE i filen (Princeton m.fl.), pr. TE-trin
//   grid_<kHz>          – generisk tabel af puls/pause-par til RAW og alt andet (afrundet)

const { PROTOCOLS, encode, findProtocol } = require('./protocols');
const { extractRepetition, merge } = require('./raw');

const CARRIERS = [433920000, 433420000, 433070000];
const CARRIER_MIN = 433000000;
const CARRIER_MAX = 433990000;
const MAX_INTERVALS = 256; // pr. frame (Homeys radio)
const MIN_US = 5;
const MAX_US = 32767;

// TE-trin: 10 µs op til 600, derefter 25 µs op til 1200.
const TE_STEPS = [];
for (let t = 100; t <= 600; t += 10) TE_STEPS.push(t);
for (let t = 625; t <= 1200; t += 25) TE_STEPS.push(t);

// Generisk tabel: logaritmisk fordelte varigheder.
const GRID_HIGH = logSteps(60, 16000, 24);
const GRID_LOW = logSteps(60, MAX_US, 32);

function logSteps(min, max, n) {
  const r = (max / min) ** (1 / (n - 1));
  return Array.from({ length: n }, (_, i) => Math.round(min * r ** i));
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const khz = (carrier) => Math.round(carrier / 1000);
const clamp = (us) => Math.min(MAX_US, Math.max(MIN_US, Math.round(us)));

// Signerede µs -> [[høj, lav], ...]. Starter med puls, slutter med pause; lange pauser begrænses.
function toPairs(frame) {
  const p = merge(frame);
  const lead = [];
  while (p.length && p[0] < 0) lead.push(p.shift());
  if (!p.length) throw err('no_pulses');
  // En indledende pause flyttes til slutningen (frames gentages, så det er det samme på luften).
  const lowEnd = lead.reduce((a, b) => a + b, 0);
  if (p[p.length - 1] < 0) p[p.length - 1] += lowEnd;
  else p.push(lowEnd || -10000);
  const pairs = [];
  for (let i = 0; i < p.length; i += 2) pairs.push([clamp(p[i]), clamp(-p[i + 1])]);
  return pairs;
}

function nearestCarrier(frequency) {
  const f = Number(frequency) || 433920000;
  if (f < CARRIER_MIN || f > CARRIER_MAX) {
    throw err('frequency', { mhz: num((f / 1e6).toFixed(2)) });
  }
  return CARRIERS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
}

function nearestTe(te) {
  return TE_STEPS.reduce((a, b) => (Math.abs(b - te) < Math.abs(a - te) ? b : a));
}

// --- Katalog (bruges af build-scriptet) ---------------------------------------------

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function sampleKeys(bits, rnd) {
  if (bits <= 10) return Array.from({ length: 2 ** bits }, (_, i) => i.toString(16));
  const keys = [0n, (1n << BigInt(bits)) - 1n];
  let a = 0n;
  for (let i = 0; i < bits; i++) a = (a << 1n) | BigInt(i % 2);
  keys.push(a, a ^ ((1n << BigInt(bits)) - 1n));
  for (let k = 0; k < 400; k++) {
    let v = 0n;
    for (let i = 0; i < bits; i++) v = (v << 1n) | (rnd() < 0.5 ? 1n : 0n);
    keys.push(v);
  }
  return keys.map((v) => (typeof v === 'string' ? v : v.toString(16)));
}

function alphabet(protocols, te) {
  const set = new Map();
  const rnd = prng(42);
  for (const p of protocols) {
    for (const bits of p.bitsMin ? [p.bitsMin, p.bitsMax] : p.bits) {
      for (const key of sampleKeys(bits, rnd)) {
        const { frame } = encode({ protocol: p.name, bits, key, te }, { te });
        for (const pair of toPairs(frame)) set.set(pair.join(','), pair);
      }
    }
  }
  return [...set.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function gridWords() {
  const words = [];
  for (const h of GRID_HIGH) for (const l of GRID_LOW) words.push([h, l]);
  return words;
}

function signalDef(words, carrier) {
  return { words, interval: 10, repetitions: 10, txOnly: true, carrier };
}

function buildCatalog() {
  const signals = {};
  const fixed = Object.values(PROTOCOLS).filter((p) => !p.teFromFile);
  const teProtocols = Object.values(PROTOCOLS).filter((p) => p.teFromFile);
  const fixedWords = fixed.map((p) => [p, alphabet([p])]);
  const teWords = TE_STEPS.map((te) => [te, alphabet(teProtocols, te)]);
  const grid = gridWords();
  for (const carrier of CARRIERS) {
    for (const [p, words] of fixedWords) signals[`p_${slug(p.name)}_${khz(carrier)}`] = signalDef(words, carrier);
    for (const [te, words] of teWords) signals[`te${te}_${khz(carrier)}`] = signalDef(words, carrier);
    signals[`grid_${khz(carrier)}`] = signalDef(grid, carrier);
  }
  return signals;
}

// --- Plan for én udsendelse ---------------------------------------------------------

function nearestIndex(values, v) {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(Math.log(values[i] / v)) < Math.abs(Math.log(values[best] / v))) best = i;
  }
  return best;
}

// code -> { signalId, frame (ord-numre), repetitions, exact, pairs, note }
// signals = manifestets signals['433'] (eller buildCatalog() i test).
function plan(code, signals, { forceGrid = false } = {}) {
  if (code.fsk) throw err('fsk');
  const carrier = nearestCarrier(code.frequency);
  const k = khz(carrier);
  let frame;
  let inner = 1;
  let candidate = null;
  let note = '';

  if (code.pulses) {
    frame = code.pulses; // allerede én gentagelse (lib/codes.js)
  } else if (code.raw) {
    const r = extractRepetition(code.raw);
    frame = r.frame;
    note = msg('note_raw', { n: r.copies });
  } else {
    const p = findProtocol(code.protocol);
    if (p && p.teFromFile) {
      const te = nearestTe(Number(code.te) || p.teDefault);
      ({ frame, inner } = encode(code, { te }));
      candidate = `te${te}_${k}`;
      if (te !== Number(code.te)) note = `TE ${code.te} → ${te} µs`;
    } else {
      ({ frame, inner } = encode(code));
      if (p) candidate = `p_${slug(p.name)}_${k}`;
    }
  }

  const pairs = toPairs(frame);
  if (pairs.length * 2 > MAX_INTERVALS) {
    throw err('too_long', { n: pairs.length * 2, max: MAX_INTERVALS });
  }
  const repetitions = Math.max(1, Math.min(255, Math.round((Number(code.repeat) || 10) * inner)));

  if (candidate && signals[candidate] && !forceGrid) {
    const index = new Map(signals[candidate].words.map((w, i) => [w.join(','), i]));
    const idx = pairs.map((pr) => index.get(pr.join(',')));
    if (idx.every((i) => i !== undefined)) {
      return { signalId: candidate, frame: idx, repetitions, inner, exact: true, pairs, note };
    }
  }

  const gridId = `grid_${k}`;
  if (!signals[gridId]) throw err('missing_signal', { id: gridId });
  const hs = [...new Set(signals[gridId].words.map((w) => w[0]))];
  const ls = [...new Set(signals[gridId].words.map((w) => w[1]))];
  const idx = pairs.map(([h, l]) => nearestIndex(hs, h) * ls.length + nearestIndex(ls, l));
  return { signalId: gridId, frame: idx, repetitions, inner, exact: false, pairs, note: [note, msg('note_grid')].filter(Boolean).join(', ') };
}

module.exports = {
  CARRIERS, TE_STEPS, GRID_HIGH, GRID_LOW, MAX_INTERVALS, toPairs, nearestCarrier, nearestTe, buildCatalog, plan, slug,
};
