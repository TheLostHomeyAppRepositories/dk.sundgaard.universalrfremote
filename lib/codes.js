'use strict';

const { err, msg, num } = require('./i18n');

// Klargør koder fra parringssiden (fil eller manuel indtastning) til lagring på enheden.

const { parseSub, normalizeKey } = require('./subfile');
const { PROTOCOLS, findProtocol, ROLLING, UNSUPPORTED, encode } = require('./protocols');
const { extractRepetition } = require('./raw');

// Liste til rullemenuen på parringssiden.
function protocolList() {
  return Object.values(PROTOCOLS)
    .map((p) => ({
      name: p.name,
      bits: p.bitsMin ? p.bitsMax : p.bits[0],
      te: p.teFromFile ? p.teDefault : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// MHz (433.92) eller Hz (433920000) -> Hz
function toHz(f) {
  const n = Number(String(f ?? '').replace(',', '.'));
  if (!n) return 433920000;
  return n < 1e4 ? Math.round(n * 1e6) : Math.round(n);
}

// Tekst med RAW-værdier ("RAW_Data: 350 -1050 ..." eller bare tal) -> tal
function parseRawText(text) {
  return String(text).replace(/RAW_Data:/g, ' ').split(/[\s,;]+/).filter(Boolean).map((v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw err('bad_raw_value', { value: v });
    return n;
  });
}

// input: { sub } eller { protocol, key, bits, te, frequency, guardTime, raw }
// -> lagringsklar kode: { protocol, bits, key, te, guardTime, frequency, pulses (RAW: én gentagelse), fileRepeat }
function prepareCode(input) {
  // Allerede klargjort RAW (fra enheden ved reparation): brug som den er.
  if (Array.isArray(input.pulses)) {
    if (input.pulses.length < 2) throw err('raw_empty');
    return { protocol: 'RAW', frequency: toHz(input.frequency), pulses: input.pulses.map(Number) };
  }
  let c;
  if (input.sub) {
    c = parseSub(input.sub);
  } else {
    c = { protocol: String(input.protocol || '').trim(), frequency: toHz(input.frequency) };
    if (c.protocol.toUpperCase() === 'RAW') {
      c.protocol = 'RAW';
      c.raw = Array.isArray(input.raw) ? input.raw.map(Number) : parseRawText(input.raw || '');
    } else {
      const p = findProtocol(c.protocol);
      if (p) c.protocol = p.name;
      c.bits = Number(input.bits) || (p ? (p.bitsMin ? p.bitsMax : p.bits[0]) : 0);
      c.key = normalizeKey(input.key || '');
      if (input.te) c.te = Number(input.te);
      if (input.guardTime) c.guardTime = Number(input.guardTime);
    }
  }
  if (c.fsk) throw err('fsk');

  const out = { protocol: c.protocol, frequency: c.frequency };
  if (c.repeat) out.fileRepeat = c.repeat;
  if (c.raw) {
    out.pulses = extractRepetition(c.raw).frame;
  } else {
    Object.assign(out, { bits: c.bits, key: c.key });
    if (c.te) out.te = c.te;
    if (c.guardTime) out.guardTime = c.guardTime;
    encode(out); // kaster forståelig fejl ved rullende/ukendt protokol, forkert bitantal m.m.
  }
  return out;
}

function describe(code) {
  if (!code) return '';
  const f = (code.frequency / 1e6).toFixed(2);
  const mhz = `${num(f)} MHz`;
  if (code.pulses) return `RAW · ${Math.ceil(code.pulses.length / 2)} ${msg('pulses')} · ${mhz}`;
  const parts = [code.protocol, `${code.bits} ${msg('bit')}`, code.key];
  if (code.te) parts.push(`TE ${code.te} µs`);
  parts.push(mhz);
  return parts.join(' · ');
}

module.exports = {
  protocolList, prepareCode, describe, toHz, parseRawText, ROLLING, UNSUPPORTED,
};
