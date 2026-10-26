'use strict';

const Homey = require('homey');
const { plan, RX_IDS } = require('./lib/radio');
const { decodeFrame, vote } = require('./lib/decode');
const { matchIds, idOf, Matcher } = require('./lib/match');
const { prepareCode, protocolList } = require('./lib/codes');
const { setLanguageSource, msg, err, broken } = require('./lib/i18n');

const LISTEN_SECONDS = 15;
const MAX_FRAMES = 60;
const QUIET_MS = 1500; // efter egen udsendelse: hør ikke Homeys eget signal som et tryk
const RX_RETRY_MS = 60000; // nyt forsøg, hvis radioen ikke kunne slås til/fra
const CACHE_SIZE = 64; // senest dekodede frames (en fjernbetjening gentager det samme frame)

class App extends Homey.App {
  async onInit() {
    setLanguageSource(() => this.homey.i18n.getLanguage());
    if (broken.length) this.error('Sprogfiler sprunget over:', broken.join('; '));
    this._queue = Promise.resolve();
    this._signals = new Map();
    this._status = { sent: 0, failed: 0, last: null, lastError: null };
    this._matcher = new Matcher();
    this._decoded = new Map();
    this._idCache = new Map();
    this._rxOn = false;
    this._rxQueue = Promise.resolve();
    this._quiet = { ids: new Set(), until: 0 };
    this._receive = { heard: 0, last: null };

    const card = this.homey.flow.getActionCard('send_code');
    card.registerArgumentAutocompleteListener('protocol', async (query) => protocolList()
      .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
      .map((p) => ({ name: p.name, description: p.te ? `${p.bits} ${msg('bit')}, TE ${p.te} µs` : `${p.bits} ${msg('bit')}`, id: p.name })));
    card.registerRunListener(async (args) => {
      const code = prepareCode({
        protocol: args.protocol.id, key: args.key, bits: args.bits, te: args.te, frequency: args.frequency,
      });
      await this.send(code, { repetitions: args.repetitions });
    });

    this.log('Started');
  }

  // Signaler hentes først, når de bruges (Homey registrerer dem ved getSignal433).
  _signal(id) {
    if (!this._signals.has(id)) this._signals.set(id, this.homey.rf.getSignal433(id));
    return this._signals.get(id);
  }

  plan(code, opts) {
    return plan(code, this.homey.manifest.signals['433'], opts);
  }

  // Sender én kode. Udsendelser køres én ad gangen, så radioen ikke får to samtidig.
  async send(code, opts = {}) {
    const p = this.plan(code, opts);
    // Gentagelser fra enheden ganges med protokollens indre kopier (fx Hörmann 20).
    const repetitions = opts.repetitions
      ? Math.max(1, Math.min(255, Math.round(Number(opts.repetitions) * p.inner)))
      : p.repetitions;
    const run = async () => {
      const started = Date.now();
      // Kun den sendte kode ignoreres, så andre fjernbetjeninger stadig høres imens.
      const quiet = { ids: new Set(this._matcher.size ? this._ids(code, this._rxTables()) : []), until: Infinity };
      this._quiet = quiet;
      try {
        await this._signal(p.signalId).tx(p.frame, { repetitions });
        this._status.sent++;
        this._status.last = {
          at: new Date().toISOString(), ms: Date.now() - started, signalId: p.signalId, repetitions,
          exact: p.exact, note: p.note, protocol: code.protocol, key: code.key,
        };
      } catch (err) {
        this._status.failed++;
        this._status.lastError = { at: new Date().toISOString(), message: err.message, signalId: p.signalId };
        throw err;
      } finally {
        quiet.until = Date.now() + QUIET_MS;
      }
    };
    const job = this._queue.then(run, run);
    this._queue = job.catch(() => {});
    await job;
    return { signalId: p.signalId, repetitions, exact: p.exact, note: p.note, pairs: p.pairs.length };
  }

  getStatus() {
    return { ...this._status, rx: this._rxOn, receiving: this._matcher.size, received: this._receive };
  }

  // --- Lyt efter rigtige fjernbetjeninger ---------------------------------------------
  // Modtagelse er tung for Homey, så radioen lytter kun, når mindst én enhed har indstillingen
  // "Lyt efter den rigtige fjernbetjening" slået til (eller lyt-fanen er åben).
  // Enhederne kalder updateReceivers(), når noget ændrer sig; kaldene samles.
  updateReceivers() {
    this.homey.clearTimeout(this._receiversTimer);
    this._receiversTimer = this.homey.setTimeout(() => this._updateReceivers().catch(this.error), 200);
  }

  async _updateReceivers() {
    const tables = this._rxTables();
    const targets = [];
    const used = new Set();
    for (const device of this.homey.drivers.getDriver('remote').getDevices()) {
      if (!device.receiving || !device.receiving()) continue;
      for (const b of device.getStoreValue('buttons') || []) {
        used.add(JSON.stringify(b.code));
        targets.push({ ids: await this._idsLater(b.code, tables), target: { device, id: b.id } });
      }
    }
    // Koder, ingen enhed lytter efter længere, glemmes.
    for (const key of this._idCache.keys()) if (!used.has(key)) this._idCache.delete(key);
    this._matcher.setTargets(targets.filter((t) => t.ids.length));
    this.log('Lytter efter', this._matcher.size, 'koder');
    await this._syncRx();
  }

  // Antal knapper, Homey kan genkende, når den rigtige fjernbetjening trykkes.
  async receivable(buttons) {
    const tables = this._rxTables();
    let n = 0;
    for (const b of buttons || []) if ((await this._idsLater(b.code, tables)).length) n++;
    return n;
  }

  // matchIds simulerer modtagelsen og tager lidt tid, så resultatet huskes pr. kode.
  _ids(code, tables) {
    const key = JSON.stringify(code);
    if (!this._idCache.has(key)) this._idCache.set(key, matchIds(code, tables));
    return this._idCache.get(key);
  }

  // Som _ids, men giver andre opgaver (udsendelser, timere) plads mellem de tunge beregninger.
  async _idsLater(code, tables) {
    await new Promise((resolve) => setImmediate(resolve));
    return this._ids(code, tables);
  }

  _rxTables() {
    return RX_IDS.map((id) => this.homey.manifest.signals['433'][id].words);
  }

  // Slår modtagelse til/fra efter behov. Køres én ad gangen.
  // Fejler det, prøves igen om lidt.
  _syncRx() {
    const job = this._rxQueue.then(async () => {
      this.homey.clearTimeout(this._rxRetry);
      const want = !!this._listening || this._matcher.size > 0;
      if (want === this._rxOn) return;
      try {
        for (const id of RX_IDS) {
          if (want) await this._rxSignal(id).enableRX();
          else await this._rxSignal(id).disableRX();
        }
        this._rxOn = want;
      } catch (e) {
        // Slå til: det hele slås fra igen, så næste forsøg starter forfra. Slå fra: _rxOn bliver
        // stående, så næste forsøg også prøver at slå fra.
        if (want) {
          for (const id of RX_IDS) await this._rxSignal(id).disableRX().catch(() => {});
          this._rxOn = false;
        }
        this._rxRetry = this.homey.setTimeout(() => this._syncRx().catch(() => {}), RX_RETRY_MS);
        throw e;
      }
    });
    this._rxQueue = job.catch((e) => this.error('Modtagelse', e.message));
    return job;
  }

  // Lytter efter en fjernbetjening og dekoder den (lyt-fanen på parringssiden).
  // -> { code, votes, frames }. Fejler med en forklaring, hvis intet blev hørt eller genkendt.
  // Kun én lytning ad gangen: en ny afbryder den forrige. Modtagelse er kun slået til, mens der
  // lyttes, eller når en enhed lytter efter sin fjernbetjening (se _syncRx).
  async listen({ seconds = LISTEN_SECONDS, onHeard } = {}) {
    this.stopListening();
    const job = { frames: [], results: [], onHeard };
    const done = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    this._listening = job;
    try {
      await this._syncRx();
    } catch (e) {
      this._finishListening(job, e);
      return done;
    }
    const ms = Math.max(1, Math.min(60, Number(seconds) || LISTEN_SECONDS)) * 1000;
    job.timer = this.homey.setTimeout(() => this._finishListening(job), ms);
    return done;
  }

  stopListening() {
    if (this._listening) this._finishListening(this._listening, err('listen_cancelled'));
  }

  _rxSignal(id) {
    if (!this._signals.has(id)) {
      const sig = this.homey.rf.getSignal433(id);
      const { words } = this.homey.manifest.signals['433'][id];
      sig.on('payload', (payload) => this._onFrame(id, payload, words));
      this._signals.set(id, sig);
    }
    return this._signals.get(id);
  }

  _onFrame(id, payload, words) {
    const pairs = payload.map((w) => words[w]).filter(Boolean);
    const job = this._listening;
    let result;
    if (job && job.frames.length < MAX_FRAMES) {
      result = this._decode(id, payload, pairs);
      job.frames.push(pairs);
      job.results.push(result);
      if (job.onHeard) job.onHeard(job.frames.length);
      if (vote(job.results)) this._finishListening(job);
    }
    // Mens lyt-fanen optager en kode, skal fjernbetjeningen ikke også styre sin enhed.
    if (job || !this._matcher.size) return;
    if (result === undefined) result = this._decode(id, payload, pairs);
    if (result && Date.now() < this._quiet.until && this._quiet.ids.has(idOf(result))) return;
    for (const { device, id: button } of this._matcher.frame(result, Date.now(), id)) {
      this._receive.heard++;
      this._receive.last = { at: new Date().toISOString(), device: device.getName(), button };
      device.received(button).catch((e) => this.error('received', e.message));
    }
  }

  // Dekoder et frame; samme ord-rækkefølge fra samme signal giver samme resultat, så det huskes.
  _decode(id, payload, pairs) {
    const key = `${id}:${payload.join(',')}`;
    if (this._decoded.has(key)) return this._decoded.get(key);
    const result = decodeFrame(pairs);
    this._decoded.set(key, result);
    if (this._decoded.size > CACHE_SIZE) this._decoded.delete(this._decoded.keys().next().value);
    return result;
  }

  _finishListening(job, error) {
    if (this._listening !== job) return;
    this._listening = null;
    this.homey.clearTimeout(job.timer);
    this._syncRx().catch(() => {});
    const result = !error && vote(job.results);
    this.log('Lyttede:', job.frames.length, 'frames,', result ? `${result.code.protocol} (${result.votes} stemmer)` : 'ingen kode');
    if (result) job.resolve({ ...result, frames: job.frames.length });
    else job.reject(error || err(job.frames.length ? 'listen_unknown' : 'listen_nothing'));
  }
}

module.exports = App;
