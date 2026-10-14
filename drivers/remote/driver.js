'use strict';

const { err } = require('../../lib/i18n');

// Fjernbetjening: brugeren tilføjer selv knapper med etiket og kode, og vælger ikon og enhedstype.
// store.buttons = [{ id: 'b1', label: 'Ind', code: {...}, role: 'up' }, ...]; hver knap er capability button.<id>.
// role (valgfri) kobler knappen til Homeys egne kontroller, se lib/roles.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Homey = require('homey');
const { protocolList, prepareCode, describe } = require('../../lib/codes');
const { ROLES, rolesFor, roleCapabilities } = require('../../lib/roles');

const ICONS = ['remote', 'awning', 'blind', 'curtain', 'window', 'screen', 'garage', 'gate', 'light', 'socket', 'fan', 'bell', 'button'];
// Enhedstyper på parringssiden; teksterne står under 'classes' i locales/<sprog>.json.
const CLASSES = ['remote', 'sunshade', 'blinds', 'curtain', 'garagedoor', 'light', 'socket', 'fan', 'doorbell', 'other'];
const MAX_BUTTONS = 16;

// Knapper fra siden -> rene knapper med stabile id'er (b1, b2, …).
// Kun id'er, enheden allerede har (known), beholdes. Nye knapper får altid et id, der aldrig
// har været brugt (nextId tæller kun op), så flows sat til en slettet knap ikke rammer en ny.
// Funktioner, der ikke passer til enhedstypen, fjernes; den samme funktion må kun bruges én gang.
function cleanButtons(buttons, { known = [], nextId = 1, deviceClass } = {}) {
  if (!Array.isArray(buttons) || !buttons.length) throw err('no_buttons');
  if (buttons.length > MAX_BUTTONS) throw err('max_buttons', { max: MAX_BUTTONS });
  const keep = new Set(known);
  const used = new Set();
  let next = Math.max(Number(nextId) || 1, ...known.map((id) => Number(id.slice(1)) + 1));
  const roles = new Map();
  const list = buttons.map((b, i) => {
    const label = String(b.label || '').trim();
    if (!label) throw err('no_label', { n: i + 1 });
    if (!b.code) throw err('no_code', { label });
    const id = keep.has(b.id) && !used.has(b.id) ? b.id : `b${next++}`;
    used.add(id);
    const out = { id, label, code: b.code };
    if (b.role && rolesFor(deviceClass).includes(b.role)) {
      if (roles.has(b.role)) throw err('role_twice', { a: roles.get(b.role), b: i + 1 });
      roles.set(b.role, i + 1);
      out.role = b.role;
    }
    return out;
  });
  return { list, nextId: next };
}

class RemoteDriver extends Homey.Driver {
  async onInit() {
    const autocomplete = async (query, args) => args.device.buttonList()
      .filter((b) => b.name.toLowerCase().includes(query.toLowerCase()));
    // Tryk fra et flow udløser ikke "Der trykkes på", ellers kan et flow udløse sig selv i ring.
    this.homey.flow.getActionCard('press_button')
      .registerArgumentAutocompleteListener('button', autocomplete)
      .registerRunListener(async (args) => args.device.press(args.button.id, { trigger: false }));
    this._pressedCard = this.homey.flow.getDeviceTriggerCard('button_pressed')
      .registerArgumentAutocompleteListener('button', autocomplete)
      .registerRunListener(async (args, state) => args.button.id === state.id);
  }

  // Ikonerne som data-URI'er, så parringssiden kan vise dem uden at kende stien.
  _icons() {
    if (!this._iconList) {
      this._iconList = ICONS.map((id) => ({
        id,
        src: `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'icons', `${id}.svg`)).toString('base64')}`,
      }));
    }
    return this._iconList;
  }

  // Venter ikke på flows: koden er allerede sendt, og en fejl her må ikke få knappen til at fejle.
  triggerPressed(device, id) {
    this._pressedCard.trigger(device, {}, { id }).catch((e) => this.error(e));
  }

  _register(session, context) {
    session.setHandler('context', async () => context);
    session.setHandler('parse', async (input) => {
      const code = prepareCode(input);
      const p = this.homey.app.plan(code); // fejl i frekvens, længde m.m. vises allerede her
      return { code, summary: describe(code), note: p.note };
    });
    session.setHandler('test', async ({ code, repetitions }) => this.homey.app.send(code, { repetitions: Number(repetitions) || 10 }));
    // Lyt: svarer med den dekodede kode (siden udfylder "Indtast" med den) og melder undervejs,
    // hvor mange frames der er hørt.
    session.setHandler('listen', async () => {
      const { code } = await this.homey.app.listen({
        onHeard: (n) => session.emit('listen_heard', n).catch(() => {}),
      });
      return code;
    });
    session.setHandler('listen_stop', async () => this.homey.app.stopListening());
    session.setHandler('disconnect', async () => this.homey.app.stopListening());
  }

  _context(extra) {
    return {
      icons: this._icons(),
      classes: CLASSES.map((id) => ({ id, label: this.homey.__(`classes.${id}`) })),
      roles: ROLES,
      protocols: protocolList(),
      maxButtons: MAX_BUTTONS,
      ...extra,
    };
  }

  async onPair(session) {
    this._register(session, this._context({
      mode: 'pair', name: '', icon: 'remote', deviceClass: 'remote', repetitions: 10, buttons: [],
    }));
    session.setHandler('device', async ({ name, icon, deviceClass: requested, repetitions, buttons }) => {
      const deviceClass = CLASSES.includes(requested) ? requested : 'remote';
      const { list, nextId } = cleanButtons(buttons, { deviceClass });
      return {
        name: String(name || '').trim() || this.homey.__('remote.title'),
        data: { id: crypto.randomUUID() },
        icon: `/icons/${ICONS.includes(icon) ? icon : 'remote'}.svg`,
        class: deviceClass,
        // Homeys kontroller først, så de står øverst på enheden
        capabilities: [...roleCapabilities(deviceClass, list), ...list.map((b) => `button.${b.id}`)],
        capabilitiesOptions: Object.fromEntries(list.map((b) => [`button.${b.id}`, { title: b.label }])),
        store: { buttons: list, nextId, deviceClass, icon },
        settings: { repetitions: Number(repetitions) || 10 },
      };
    });
  }

  async onRepair(session, device) {
    this._register(session, this._context({
      mode: 'repair',
      name: device.getName(),
      icon: device.getStoreValue('icon') || 'remote',
      deviceClass: device.getClass(),
      repetitions: device.getSetting('repetitions'),
      buttons: device.getStoreValue('buttons') || [],
    }));
    session.setHandler('save', async ({ deviceClass, repetitions, buttons }) => {
      // Typen sættes før knapperne, så Homeys kontroller passer til den nye type.
      const cls = CLASSES.includes(deviceClass) ? deviceClass : device.getClass();
      const { list, nextId } = cleanButtons(buttons, {
        known: (device.getStoreValue('buttons') || []).map((b) => b.id),
        nextId: device.getStoreValue('nextId'),
        deviceClass: cls,
      });
      // nextId gemmes først, så id'er aldrig genbruges, heller ikke hvis resten fejler.
      await device.setStoreValue('nextId', nextId);
      const oldClass = device.getClass();
      const oldButtons = device.getStoreValue('buttons') || [];
      try {
        if (cls !== oldClass) await device.setClass(cls);
        await device.applyButtons(list);
      } catch (e) {
        // Rul tilbage til den gamle type og de gamle knapper, så enheden ikke står halvt ændret.
        if (device.getClass() !== oldClass) await device.setClass(oldClass).catch(this.error);
        await device.applyButtons(oldButtons).catch(this.error);
        throw e;
      }
      await device.setSettings({ repetitions: Number(repetitions) || 10 });
    });
  }
}

module.exports = RemoteDriver;
