'use strict';

const { err } = require('./i18n');

// Læser Flipper Zero .sub-filer (Key, RAW og BinRAW) til et kode-objekt:
// { frequency, preset, protocol, bits, key (hex-streng), te, repeat, guardTime, serial, raw: [signerede µs] }

const FSK_PRESET = /2FSK|GFSK|MSK/i;

function parseSub(text) {
  if (typeof text !== 'string' || !text.trim()) throw err('empty_file');
  const fields = {};
  const raw = [];
  const binBlocks = [];
  let pendingBits = null;

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if (name === 'RAW_Data') {
      for (const v of value.split(/\s+/)) if (v) raw.push(parseInt(v, 10));
    } else if (name === 'Bit_RAW') {
      pendingBits = parseInt(value, 10);
    } else if (name === 'Data_RAW') {
      binBlocks.push({ bits: pendingBits, hex: value });
      pendingBits = null;
    } else if (!(name in fields)) {
      fields[name] = value;
    }
  }

  if (!/Flipper SubGhz/i.test(fields.Filetype || '')) throw err('not_flipper');
  const preset = fields.Preset || '';
  const code = {
    frequency: fields.Frequency ? parseInt(fields.Frequency, 10) : 433920000,
    preset,
    protocol: fields.Protocol || 'RAW',
  };
  if (FSK_PRESET.test(preset)) code.fsk = true;
  if (fields.Repeat) code.repeat = parseInt(fields.Repeat, 10);

  if (code.protocol === 'RAW') {
    if (raw.some(Number.isNaN) || raw.length < 4) throw err('raw_invalid');
    code.raw = raw;
    return code;
  }
  if (code.protocol === 'BinRAW') {
    code.te = parseInt(fields.TE, 10);
    code.raw = binRawToPulses(binBlocks, code.te);
    return code;
  }

  code.bits = parseInt(fields.Bit, 10);
  code.key = normalizeKey(fields.Key || '');
  if (fields.TE) code.te = parseInt(fields.TE, 10);
  if (fields.Guard_time) code.guardTime = parseInt(fields.Guard_time, 10);
  if (fields.Serial) code.serial = fields.Serial.replace(/\s+/g, '');
  return code;
}

// "00 00 00 00 00 5A 3C 94", "0x5A3C94" eller "5A3C94" -> "5A3C94" (uden foranstillede nuller)
function normalizeKey(key) {
  const hex = String(key).replace(/^0x/i, '').replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{1,16}$/.test(hex)) throw err('bad_key', { key });
  return hex.replace(/^0+(?=.)/, '');
}

// BinRAW: hver blok er MSB-først med venstre-udfyldning; 1 bit = TE µs, 1 = sender, 0 = pause.
function binRawToPulses(blocks, te) {
  if (!te || !blocks.length) throw err('binraw_invalid');
  const bits = [];
  for (const { bits: n, hex } of blocks) {
    const bytes = hex.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
    const all = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) all.push((b >> i) & 1);
    bits.push(...all.slice(all.length - n));
  }
  const pulses = [];
  for (const b of bits) {
    const sign = b ? 1 : -1;
    const last = pulses[pulses.length - 1];
    if (last && Math.sign(last) === sign) pulses[pulses.length - 1] += sign * te;
    else pulses.push(sign * te);
  }
  return pulses;
}

module.exports = { parseSub, normalizeKey, binRawToPulses };
