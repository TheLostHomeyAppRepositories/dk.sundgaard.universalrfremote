'use strict';

const Homey = require('homey');
const { plan, RX_IDS } = require('./lib/radio');
const { decodeFrame, vote } = require('./lib/decode');
const { prepareCode, protocolList } = require('./lib/codes');
const { setLanguageSource, msg, err, broken } = require('./lib/i18n');

const LISTEN_SECONDS = 15;
const MAX_FRAMES = 60;

class App extends Homey.App {
  async onInit() {
    setLanguageSource(() => this.homey.i18n.getLanguage());
    if (broken.length) this.error('Sprogfiler sprunget over:', broken.join('; '));
    this._queue = Promise.resolve();
    this._signals = new Map();
    this._status = { sent: 0, failed: 0, last: null, lastError: null };

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
      }
    };
    const job = this._queue.then(run, run);
    this._queue = job.catch(() => {});
    await job;
    return { signalId: p.signalId, repetitions, exact: p.exact, note: p.note, pairs: p.pairs.length };
  }

  getStatus() {
    return this._status;
  }

  // Lytter efter en fjernbetjening og dekoder den (lyt-fanen på parringssiden).
  // -> { code, votes, frames }. Fejler med en forklaring, hvis intet blev hørt eller genkendt.
  // Kun én lytning ad gangen: en ny afbryder den forrige. Modtagelse er tung for Homey, så den
  // er kun slået til, mens der lyttes.
  async listen({ seconds = LISTEN_SECONDS, onHeard } = {}) {
    this.stopListening();
    const job = { frames: [], results: [], onHeard };
    const done = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    this._listening = job;
    try {
      for (const id of RX_IDS) await this._rxSignal(id).enableRX();
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
      sig.on('payload', (payload) => this._onFrame(payload.map((w) => words[w]).filter(Boolean)));
      this._signals.set(id, sig);
    }
    return this._signals.get(id);
  }

  _onFrame(pairs) {
    const job = this._listening;
    if (!job || job.frames.length >= MAX_FRAMES) return;
    job.frames.push(pairs);
    job.results.push(decodeFrame(pairs));
    if (job.onHeard) job.onHeard(job.frames.length);
    if (vote(job.results)) this._finishListening(job);
  }

  _finishListening(job, error) {
    if (this._listening !== job) return;
    this._listening = null;
    this.homey.clearTimeout(job.timer);
    for (const id of RX_IDS) {
      this._rxSignal(id).disableRX().catch((e) => this.error('disableRX', id, e.message));
    }
    const result = !error && vote(job.results);
    this.log('Lyttede:', job.frames.length, 'frames,', result ? `${result.code.protocol} (${result.votes} stemmer)` : 'ingen kode');
    if (result) job.resolve({ ...result, frames: job.frames.length });
    else job.reject(error || err(job.frames.length ? 'listen_unknown' : 'listen_nothing'));
  }
}

module.exports = App;
