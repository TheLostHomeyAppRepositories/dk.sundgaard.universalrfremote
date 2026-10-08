'use strict';

// Selvtest uden Homey: node test/selftest.js
const assert = require('assert');
const { parseSub, binRawToPulses } = require('../lib/subfile');
const { encode, PROTOCOLS } = require('../lib/protocols');
const { extractRepetition } = require('../lib/raw');
const { buildCatalog, plan, toPairs } = require('../lib/radio');
const { prepareCode, describe } = require('../lib/codes');
const { setLanguage } = require('../lib/i18n');

setLanguage('da');

const MARKISE_UD = `Filetype: Flipper SubGhz Key File
Version: 1
Frequency: 433920000
Preset: FuriHalSubGhzPresetOok270Async
Protocol: Princeton
Bit: 24
Key: 00 00 00 00 00 5A 3C 98
TE: 211
Repeat: 200
`;

// .sub-fil
const c = parseSub(MARKISE_UD);
assert.deepStrictEqual(
  { f: c.frequency, p: c.protocol, b: c.bits, k: c.key, te: c.te, r: c.repeat },
  { f: 433920000, p: 'Princeton', b: 24, k: '5A3C98', te: 211, r: 200 },
);
assert.throws(() => parseSub('hej'), /Flipper/);

// Princeton: 1 = 3TE/1TE, 0 = 1TE/3TE, stopbit TE, pause 30 TE
const pr = encode({ protocol: 'Princeton', bits: 24, key: '5A3C98', te: 100 }).frame;
assert.strictEqual(pr.length, 50);
assert.deepStrictEqual(pr.slice(0, 4), [100, -300, 300, -100]); // 5 = 0101
assert.deepStrictEqual(pr.slice(4, 6), [100, -300]);
assert.deepStrictEqual(pr.slice(-2), [100, -3000]);

// CAME 12 bit: pause 47*320, startbit, 1 = pause 640/puls 320
const came = encode({ protocol: 'CAME', bits: 12, key: '800' }).frame;
assert.deepStrictEqual(came.slice(0, 4), [-47 * 320, 320, -640, 320]);

// Dooya: header afhænger af LSB, start 13*366 / 2*733
const dooya = encode({ protocol: 'Dooya', bits: 40, key: '1' }).frame;
assert.deepStrictEqual(dooya.slice(0, 3), [-(12 * 733 + 733), 13 * 366, -2 * 733]);

// Rullende og ukendte protokoller afvises forståeligt
assert.throws(() => encode({ protocol: 'KeeLoq', bits: 64, key: '1' }), /rullende/);
assert.throws(() => encode({ protocol: 'Princeton', bits: 12, key: '1', te: 300 }), /24/);

// Alle encodere kan køre og giver vekslende niveauer
for (const p of Object.values(PROTOCOLS)) {
  const bits = p.bitsMin ? p.bitsMax : p.bits[0];
  const { frame } = encode({ protocol: p.name, bits, key: 'A5', te: p.teDefault });
  for (let i = 1; i < frame.length; i++) assert.notStrictEqual(Math.sign(frame[i]), Math.sign(frame[i - 1]), p.name);
  assert.ok(toPairs(frame).length * 2 <= 256, `${p.name} for lang`);
}

// MegaCode (bygges baglæns i Flipper): 2*Bit elementer, slutter med puls
const mega = encode({ protocol: 'MegaCode', bits: 24, key: '1' }).frame;
assert.strictEqual(mega.length, 48);
assert.strictEqual(mega[0], -11000);
assert.strictEqual(mega[47], 1000);

// BinRAW-eksemplet fra Flippers dokumentation: TE 100, 0x37 = 00110111
assert.deepStrictEqual(binRawToPulses([{ bits: 8, hex: '37' }], 100), [-200, 200, -100, 300]);

// RAW: støj + 3 gentagelser -> én gentagelse med median-tider
const rep = [350, -1050, 1050, -350, 350, -1050, 1050, -350, 350, -10800];
// Første gentagelse har støj foran og tæller ikke med.
const noisy = [80, -40, ...rep, ...rep, ...rep.map((v) => Math.round(v * 1.04)), ...rep, 120];
const ex = extractRepetition(noisy);
assert.strictEqual(ex.copies, 3);
assert.deepStrictEqual(ex.frame, rep);

// Plan: markisen giver præcist Princeton-signal ved TE 210
const catalog = buildCatalog();
const p1 = plan(prepareCode({ sub: MARKISE_UD }), catalog);
assert.strictEqual(p1.signalId, 'te210_433920');
assert.ok(p1.exact);
assert.strictEqual(p1.frame.length, 25);
for (const [i, w] of p1.frame.entries()) assert.deepStrictEqual(catalog[p1.signalId].words[w], p1.pairs[i]);

// Faste protokoller giver præcise signaler; tvunget tabel giver ord-numre over 255
assert.ok(plan({ protocol: 'Dooya', bits: 40, key: '123456789A', frequency: 433920000 }, catalog).exact);
const g = plan(prepareCode({ sub: MARKISE_UD }), catalog, { forceGrid: true });
assert.strictEqual(g.signalId, 'grid_433920');
assert.ok(Math.max(...g.frame) > 255);

// Frekvens: nærmeste bærebølge, uden for 433,00–433,99 afvises
assert.strictEqual(plan({ ...c, frequency: 433420000 }, catalog).signalId, 'te210_433420');
assert.throws(() => plan({ ...c, frequency: 868350000 }, catalog), /433,00/);
assert.throws(() => prepareCode({ sub: MARKISE_UD.replace('Ook270', '2FSKDev476') }), /FSK/);

// Manuel indtastning som Flipper viser den
const manual = prepareCode({ protocol: 'princeton', key: '00 00 00 00 00 5A 3C 94', bits: 24, te: 211, frequency: '433,92' });
assert.strictEqual(describe(manual), 'Princeton · 24 bit · 5A3C94 · TE 211 µs · 433,92 MHz');
const raw = prepareCode({ protocol: 'RAW', raw: `RAW_Data: ${noisy.join(' ')}`, frequency: 433.92 });
assert.deepStrictEqual(raw.pulses, rep);
assert.deepStrictEqual(prepareCode({ pulses: raw.pulses, frequency: raw.frequency }).pulses, rep);
assert.ok(!plan(raw, catalog).exact);

// Engelske tekster
setLanguage('en');
assert.throws(() => encode({ protocol: 'KeeLoq', bits: 64, key: '1' }), /rolling codes/);
assert.throws(() => plan({ ...c, frequency: 868350000 }, catalog), /433.00–433.99 MHz/);
setLanguage('da');

console.log('OK – alle selvtest bestået');
