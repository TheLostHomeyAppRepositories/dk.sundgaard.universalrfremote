'use strict';

const Homey = require('homey');
const { describe } = require('../../lib/codes');
const { ROLE_CAPABILITIES, roleMap, roleCapabilities } = require('../../lib/roles');
const { CoverModel, slider } = require('../../lib/cover');
const { err, msg } = require('../../lib/i18n');

class RemoteDevice extends Homey.Device {
  async onInit() {
    this._listening = new Set();
    // Køretiden holdes her, fordi getSetting() stadig giver den gamle værdi under onSettings.
    this._travel = Number(this.getSetting('travel_time')) || 0;
    for (const b of this.getStoreValue('buttons') || []) this._listen(b.id);
    await this._syncRoles();
    // En bevægelse, der var i gang før en genstart, regnes færdig ud fra dens starttid.
    if (this._model().motion) await this._scheduleSettle();
    await this._updateInfo();
    this._receive = !!this.getSetting('receive');
    this.homey.app.updateReceivers();
  }

  async onDeleted() {
    this._deleted = true;
    this.homey.app.updateReceivers();
  }

  async onUninit() {
    this.homey.clearTimeout(this._moveTimer);
    this.homey.clearTimeout(this._settleTimer);
  }

  _listen(id) {
    this.registerCapabilityListener(`button.${id}`, () => this.press(id));
  }

  buttonList() {
    return (this.getStoreValue('buttons') || []).map((b) => ({ id: b.id, name: b.label, description: describe(b.code) }));
  }

  _roles() {
    return roleMap(this.getClass(), this.getStoreValue('buttons'));
  }

  // trigger: false når trykket kommer fra et flow eller fra Homeys egne kontroller (se driver.js).
  // scheduled: true kun for det Stop, en positionering selv har planlagt.
  async press(id, { trigger = true, scheduled = false } = {}) {
    const b = (this.getStoreValue('buttons') || []).find((x) => x.id === id);
    if (!b) throw new Error(this.homey.__('error.no_code'));
    // Ethvert andet tryk (knap, flow, Homeys kontroller) afbryder en igangværende positionering,
    // ellers ville det planlagte Stop standse den nye bevægelse.
    if (!scheduled) this.homey.clearTimeout(this._moveTimer);
    const entry = Object.entries(this._roles()).find(([, bid]) => bid === id);
    const role = entry && entry[0];
    // Positionen starter, når koden begynder at blive sendt (motoren reagerer på første frame),
    // men rulles tilbage, hvis udsendelsen fejler.
    const before = this._model().snapshot();
    if (role) this._beforeRole(role);
    try {
      await this.homey.app.send(b.code, { repetitions: this.getSetting('repetitions') || 10 });
    } catch (e) {
      this._model().restore(before);
      throw e;
    }
    if (role) await this._afterRole(role);
    if (trigger) this.driver.triggerPressed(this, b.id);
  }

  // Lyttes der efter den rigtige fjernbetjening? (Indstillingen "receive", se app.js.)
  receiving() {
    return this._receive && !this._deleted;
  }

  // Knappen blev trykket på den rigtige fjernbetjening: opdater Homeys kontroller, som om Homey
  // selv havde sendt koden (markisen kører jo), og start "… blev trykket på fjernbetjeningen".
  async received(id) {
    // Matcheren opdateres først lidt efter (app.updateReceivers), så tjek selv.
    if (!this.receiving() || !(this.getStoreValue('buttons') || []).some((x) => x.id === id)) return;
    this.homey.clearTimeout(this._moveTimer);
    const entry = Object.entries(this._roles()).find(([, bid]) => bid === id);
    if (entry) {
      this._beforeRole(entry[0]);
      await this._afterRole(entry[0]);
    }
    this.driver.triggerReceived(this, id);
  }

  async _pressRole(role, opts = {}) {
    const id = this._roles()[role];
    if (!id) throw err('no_role');
    await this.press(id, { ...opts, trigger: false });
  }

  // --- Homeys egne kontroller ---------------------------------------------------------

  _model() {
    const travelMs = this._travel * 1000 || 1;
    if (!this._cover) {
      this._cover = new CoverModel(travelMs);
      // 'cover' = { position, motion }; ældre udviklerudgaver gemte kun 'position'.
      this._cover.restore(this.getStoreValue('cover') || { position: this.getStoreValue('position') ?? 1 });
    } else if (this._cover.travelMs !== travelMs) {
      this._cover.retime(travelMs, Date.now());
    }
    return this._cover;
  }

  async _persist() {
    await this.setStoreValue('cover', this._model().snapshot()).catch(this.error);
  }

  _beforeRole(role) {
    const now = Date.now();
    if (role === 'up') this._model().start(1, now);
    else if (role === 'down') this._model().start(-1, now);
    else if (role === 'stop') this._model().stop(now);
  }

  async _afterRole(role) {
    const set = (cap, v) => (this.hasCapability(cap) ? this.setCapabilityValue(cap, v).catch(this.error) : null);
    if (role === 'up' || role === 'down' || role === 'stop') {
      await set('windowcoverings_state', { up: 'up', down: 'down', stop: 'idle' }[role]);
      if (role !== 'stop') await set('garagedoor_closed', role === 'down');
      await this._persist();
      await this._scheduleSettle();
    } else if (role === 'on' || role === 'off') {
      await set('onoff', role === 'on');
    } else if (role === 'toggle') {
      await set('onoff', !this.getCapabilityValue('onoff'));
      await set('garagedoor_closed', !this.getCapabilityValue('garagedoor_closed'));
    }
  }

  // Når bevægelsen er slut: gem positionen, opdater skyderen og sæt op/ned-kontrollen til stille.
  // Kun med en køretid ved vi, hvornår markisen er færdig.
  async _scheduleSettle() {
    this.homey.clearTimeout(this._settleTimer);
    if (!this.hasCapability('windowcoverings_set')) return null;
    const done = async () => {
      const m = this._model(); // ved udløb, så en ny køretid eller bevægelse tæller med
      m.settle(Date.now());
      if (m.motion) return this._scheduleSettle();
      const p = Math.round(m.at(Date.now()) * 100) / 100;
      await this._persist();
      await this.setCapabilityValue('windowcoverings_set', slider(this.getClass(), p)).catch(this.error);
      if (this.hasCapability('windowcoverings_state') && this.getCapabilityValue('windowcoverings_state') !== 'idle') {
        await this.setCapabilityValue('windowcoverings_state', 'idle').catch(this.error);
      }
      return null;
    };
    const m = this._model();
    if (!m.motion) return done();
    const now = Date.now();
    const left = m.motion.dir > 0 ? (1 - m.at(now)) : m.at(now);
    this._settleTimer = this.homey.setTimeout(() => done().catch(this.error), left * m.travelMs + 500);
    return null;
  }

  async _setPosition(target) {
    this.homey.clearTimeout(this._moveTimer);
    const plan = this._model().plan(slider(this.getClass(), target), Date.now());
    if (!plan) return;
    await this._pressRole(plan.dir > 0 ? 'up' : 'down');
    if (plan.ms === null) return;
    // Stop regnes fra starten af Op/Ned, ikke fra når udsendelsen er færdig.
    const started = this._model().motion ? this._model().motion.t0 : Date.now();
    const wait = Math.max(0, started + plan.ms - Date.now());
    this._moveTimer = this.homey.setTimeout(() => this._pressRole('stop', { scheduled: true }).catch(this.error), wait);
  }

  async _onoff(value) {
    const r = this._roles();
    if (value && r.on) return this._pressRole('on');
    if (!value && r.off) return this._pressRole('off');
    if (r.toggle && value !== this.getCapabilityValue('onoff')) return this._pressRole('toggle');
    if (!r.toggle) throw err('no_role');
    return null;
  }

  async _garage(closed) {
    const r = this._roles();
    if (closed && r.down) return this._pressRole('down');
    if (!closed && r.up) return this._pressRole('up');
    if (r.toggle && closed !== this.getCapabilityValue('garagedoor_closed')) return this._pressRole('toggle');
    if (!r.toggle) throw err('no_role');
    return null;
  }

  // Tilføjer/fjerner Homeys kontroller, så de passer til knappernes funktioner og køretiden.
  // Startværdier: fjernbetjeningen melder ikke tilbage, så vi antager slukket, lukket og stille
  // (ellers ville første Skift vende null til "tændt"/"lukket").
  async _syncRoles(travelTime = this._travel) {
    const want = roleCapabilities(this.getClass(), this.getStoreValue('buttons'), Number(travelTime) || 0);
    const initial = { onoff: false, garagedoor_closed: true, windowcoverings_state: 'idle' };
    for (const cap of ROLE_CAPABILITIES) {
      if (want.includes(cap) && !this.hasCapability(cap)) await this.addCapability(cap);
      if (!want.includes(cap) && this.hasCapability(cap)) await this.removeCapability(cap);
      if (want.includes(cap) && cap in initial && this.getCapabilityValue(cap) === null) {
        await this.setCapabilityValue(cap, initial[cap]).catch(this.error);
      }
    }
    const listeners = {
      onoff: (v) => this._onoff(v),
      windowcoverings_state: (v) => this._pressRole({ up: 'up', down: 'down', idle: 'stop' }[v]),
      windowcoverings_set: (v) => this._setPosition(v),
      garagedoor_closed: (v) => this._garage(v),
    };
    for (const cap of want) {
      if (this._listening.has(cap)) continue;
      this.registerCapabilityListener(cap, listeners[cap]);
      this._listening.add(cap);
    }
    // Skyderen sættes altid (også når typen skifter mellem markise og persienne, der vender modsat).
    if (want.includes('windowcoverings_set')) {
      const p = Math.round(this._model().at(Date.now()) * 100) / 100;
      await this.setCapabilityValue('windowcoverings_set', slider(this.getClass(), p)).catch(this.error);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    // Kan ingen af knapperne genkendes, afvises "Lyt"; kan kun nogle, siges det (Homey viser teksten).
    let message;
    if (changedKeys.includes('receive') && newSettings.receive) {
      const buttons = this.getStoreValue('buttons') || [];
      const n = await this.homey.app.receivable(buttons);
      if (!n) throw err('receive_none');
      if (n < buttons.length) message = msg('receive_some', { n, total: buttons.length });
    }
    if (changedKeys.includes('travel_time')) {
      // Den nye køretid gælder straks; positionen og en igangværende bevægelse bevares.
      this._travel = Number(newSettings.travel_time) || 0;
      this._model();
      await this._syncRoles(this._travel);
      await this._persist();
      await this._scheduleSettle();
    }
    if (changedKeys.includes('receive')) {
      this._receive = !!newSettings.receive;
      this.homey.app.updateReceivers();
    }
    return message;
  }

  // Ny knapliste fra reparation. Homeys kontroller kommer først, derefter knapperne i den nye
  // rækkefølge (Homey viser capabilities i den rækkefølge, de er tilføjet).
  async applyButtons(buttons) {
    for (const cap of this.getCapabilities()) if (cap.startsWith('button.')) await this.removeCapability(cap);
    await this.setStoreValue('buttons', buttons);
    await this._syncRoles();
    for (const b of buttons) {
      await this.addCapability(`button.${b.id}`);
      await this.setCapabilityOptions(`button.${b.id}`, { title: b.label });
      this._listen(b.id);
    }
    await this._updateInfo();
    this.homey.app.updateReceivers();
  }

  async _updateInfo() {
    const lines = (this.getStoreValue('buttons') || []).map((b) => `${b.label}: ${describe(b.code)}`);
    await this.setSettings({ codes_info: lines.join('\n') || '-' }).catch(this.error);
  }
}

module.exports = RemoteDevice;
