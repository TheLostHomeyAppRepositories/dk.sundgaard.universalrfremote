'use strict';
// Enhedstest uden Homey: kører drivers/remote/device.js mod en falsk Homey med styrbar tid.
// Scenarierne (#1, #3–#9) er fundene fra code review af 1.3.0. Kør: node test/devicetest.js
const assert = require('assert');
const Module = require('module');

const root = require('path').join(__dirname, '..');
let now = 1_000_000;
Date.now = () => now;
let timers = [];
let tid = 0;
const sent = [];
let failNext = false;

class Device {
  constructor({ cls, buttons, settings, store = {} }) {
    this._cls = cls;
    this._store = { buttons, ...store };
    this._settings = settings;
    this._caps = {};
    this._capOrder = [];
    this._listeners = {};
    this.homey = {
      setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, at: now + ms, fn }); return id; },
      clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
      __: (k) => k,
      app: {
        send: async (code) => {
          if (failNext) { failNext = false; throw new Error('radio fejl'); }
          sent.push(code.key);
        },
      },
    };
    this.driver = { triggerPressed: () => {} };
  }
  getClass() { return this._cls; }
  getStoreValue(k) { return this._store[k] ?? null; }
  async setStoreValue(k, v) { this._store[k] = JSON.parse(JSON.stringify(v)); }
  getSetting(k) { return this._settings[k]; }
  async setSettings() {}
  hasCapability(c) { return c in this._caps; }
  getCapabilities() { return [...this._capOrder]; }
  async addCapability(c) { this._caps[c] = null; this._capOrder.push(c); }
  async removeCapability(c) { delete this._caps[c]; this._capOrder = this._capOrder.filter((x) => x !== c); }
  async setCapabilityOptions() {}
  getCapabilityValue(c) { return this._caps[c] ?? null; }
  async setCapabilityValue(c, v) { if (!(c in this._caps)) throw new Error(`mangler ${c}`); this._caps[c] = v; }
  registerCapabilityListener(c, fn) { this._listeners[c] = fn; }
  error(...a) { console.error('  device.error:', ...a.map((x) => x && x.message ? x.message : x)); }
  log() {}
  // hjælpere
  async ui(cap, v) { await this._listeners[cap](v); this._caps[cap] = v; }
}

const orig = Module._load;
Module._load = function load(req, ...rest) {
  if (req === 'homey') return { Device };
  return orig.call(this, req, ...rest);
};
const RemoteDevice = require(`${root}/drivers/remote/device.js`);

async function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    now = t.at;
    await t.fn();
    await new Promise((r) => setImmediate(r));
  }
  now = end;
}

const code = (key) => ({ protocol: 'Princeton', bits: 24, key, te: 211, frequency: 433920000 });
const coverButtons = [
  { id: 'b1', label: 'Op', code: code('UP'), role: 'up' },
  { id: 'b2', label: 'Stop', code: code('STOP'), role: 'stop' },
  { id: 'b3', label: 'Ned', code: code('DOWN'), role: 'down' },
];
async function make(opts) {
  timers = [];
  sent.length = 0;
  const d = new RemoteDevice({ settings: { repetitions: 1, travel_time: 20 }, ...opts });
  await d.onInit();
  return d;
}

(async () => {
  // #1: Op fra Homeys kontrol under en positionering må ikke blive stoppet af det planlagte Stop
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    assert.deepStrictEqual(d._capOrder.slice(0, 2), ['windowcoverings_state', 'windowcoverings_set']);
    await d.ui('windowcoverings_set', 0.5); // fra 1 til 0.5: Ned, Stop efter 10 s
    assert.deepStrictEqual(sent, ['DOWN']);
    await advance(3000);
    await d.ui('windowcoverings_state', 'up');
    await advance(30000);
    assert.deepStrictEqual(sent, ['DOWN', 'UP'], `#1: ${sent}`);
    // også et flow-tryk (press med trigger:false)
    sent.length = 0;
    await d.ui('windowcoverings_set', 0.5);
    await advance(2000);
    await d.press('b1', { trigger: false });
    await advance(30000);
    assert.deepStrictEqual(sent, ['DOWN', 'UP'], `#1 flow: ${sent}`);
    // men en uforstyrret positionering sender stadig Stop
    sent.length = 0;
    await d.ui('windowcoverings_set', 0.5);
    await advance(11000);
    assert.deepStrictEqual(sent, ['DOWN', 'STOP']);
    assert.ok(Math.abs(d.getCapabilityValue('windowcoverings_set') - 0.5) < 0.02);
  }

  // #9: efter en fuld kørsel går op/ned-kontrollen til idle
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    await d.ui('windowcoverings_set', 0); // helt ned, ingen Stop
    assert.strictEqual(d.getCapabilityValue('windowcoverings_state'), 'down');
    await advance(21000);
    assert.strictEqual(d.getCapabilityValue('windowcoverings_state'), 'idle', '#9');
    assert.strictEqual(d.getCapabilityValue('windowcoverings_set'), 0);
    assert.deepStrictEqual(sent, ['DOWN']);
  }

  // #3: fejler udsendelsen, flytter positionen sig ikke
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    failNext = true;
    await assert.rejects(d.press('b3'));
    await advance(10000);
    assert.strictEqual(d._model().at(Date.now()), 1, '#3');
    assert.strictEqual(d._model().motion, null);
  }

  // #4/#5: køretid ændres midt i en bevægelse -> position og bevægelse bevares, ny hastighed bruges
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    await d.press('b3'); // ned med 20 s
    await advance(5000); // 0.75
    d._settings.travel_time = 20; // Homey har ikke gemt den nye endnu
    await d.onSettings({ newSettings: { travel_time: 10 }, changedKeys: ['travel_time'] });
    assert.strictEqual(d._model().travelMs, 10000, '#5');
    assert.ok(Math.abs(d._model().at(Date.now()) - 0.75) < 1e-9, '#4');
    await advance(2500);
    assert.ok(Math.abs(d._model().at(Date.now()) - 0.5) < 1e-9, '#4 ny hastighed');
    await advance(10000);
    assert.strictEqual(d.getCapabilityValue('windowcoverings_set'), 0);
  }

  // #6: genstart midt i en bevægelse
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    await d.press('b3');
    await advance(5000);
    const store = JSON.parse(JSON.stringify(d._store));
    await d.onUninit();
    const d2 = await make({ cls: 'blinds', buttons: coverButtons, store });
    assert.ok(Math.abs(d2._model().at(Date.now()) - 0.75) < 1e-9, '#6');
    await advance(20000);
    assert.strictEqual(d2.getCapabilityValue('windowcoverings_set'), 0, '#6 settle efter genstart');
  }

  // #7: onUninit rydder også settle-timeren
  {
    const d = await make({ cls: 'blinds', buttons: coverButtons });
    await d.press('b3');
    assert.ok(timers.length > 0);
    await d.onUninit();
    assert.strictEqual(timers.length, 0, '#7');
  }

  // #8: Skift på en ny garageport / stikkontakt starter fra en kendt tilstand
  {
    const g = await make({ cls: 'garagedoor', buttons: [{ id: 'b1', label: 'Port', code: code('T'), role: 'toggle' }] });
    assert.strictEqual(g.getCapabilityValue('garagedoor_closed'), true);
    await g.press('b1');
    assert.strictEqual(g.getCapabilityValue('garagedoor_closed'), false, '#8 port');
    const s = await make({ cls: 'socket', buttons: [{ id: 'b1', label: 'Skift', code: code('T'), role: 'toggle' }] });
    assert.strictEqual(s.getCapabilityValue('onoff'), false);
    await s.ui('onoff', true);
    assert.deepStrictEqual(sent, ['T']);
    await s.ui('onoff', true); // allerede tændt -> sender ikke igen
    assert.deepStrictEqual(sent, ['T'], '#8 stikkontakt');
  }

  // Markise: skyderen er vendt (100 % = helt ude)
  {
    const d = await make({ cls: 'sunshade', buttons: coverButtons });
    assert.strictEqual(d.getCapabilityValue('windowcoverings_set'), 0); // helt inde
    await d.ui('windowcoverings_set', 0.25); // 25 % ude = Ned i 5 s
    await advance(6000);
    assert.deepStrictEqual(sent, ['DOWN', 'STOP']);
    assert.ok(Math.abs(d.getCapabilityValue('windowcoverings_set') - 0.25) < 0.02);
  }
  console.log('OK – alle enhedstest bestået');
})().catch((e) => { console.error('FEJL:', e.message); process.exit(1); });
