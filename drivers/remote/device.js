'use strict';

const Homey = require('homey');
const { describe } = require('../../lib/codes');

class RemoteDevice extends Homey.Device {
  async onInit() {
    for (const b of this.getStoreValue('buttons') || []) this._listen(b.id);
    await this._updateInfo();
  }

  _listen(id) {
    this.registerCapabilityListener(`button.${id}`, () => this.press(id));
  }

  buttonList() {
    return (this.getStoreValue('buttons') || []).map((b) => ({ id: b.id, name: b.label, description: describe(b.code) }));
  }

  // trigger: false når trykket kommer fra et flow (se driver.js).
  async press(id, { trigger = true } = {}) {
    const b = (this.getStoreValue('buttons') || []).find((x) => x.id === id);
    if (!b) throw new Error(this.homey.__('error.no_code'));
    await this.homey.app.send(b.code, { repetitions: this.getSetting('repetitions') || 10 });
    if (trigger) this.driver.triggerPressed(this, b.id);
  }

  // Ny knapliste fra reparation. Knapperne genoprettes i den nye rækkefølge
  // (Homey viser capabilities i den rækkefølge, de er tilføjet).
  async applyButtons(buttons) {
    for (const cap of this.getCapabilities()) if (cap.startsWith('button.')) await this.removeCapability(cap);
    await this.setStoreValue('buttons', buttons);
    for (const b of buttons) {
      await this.addCapability(`button.${b.id}`);
      await this.setCapabilityOptions(`button.${b.id}`, { title: b.label });
      this._listen(b.id);
    }
    await this._updateInfo();
  }

  async _updateInfo() {
    const lines = (this.getStoreValue('buttons') || []).map((b) => `${b.label}: ${describe(b.code)}`);
    await this.setSettings({ codes_info: lines.join('\n') || '-' }).catch(this.error);
  }
}

module.exports = RemoteDevice;
