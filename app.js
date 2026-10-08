'use strict';

const Homey = require('homey');
const { plan } = require('./lib/radio');
const { prepareCode, protocolList } = require('./lib/codes');
const { setLanguage } = require('./lib/i18n');

class App extends Homey.App {
  async onInit() {
    setLanguage(this.homey.i18n.getLanguage());
    this._queue = Promise.resolve();
    this._signals = new Map();
    this._status = { sent: 0, failed: 0, last: null, lastError: null };

    const card = this.homey.flow.getActionCard('send_code');
    card.registerArgumentAutocompleteListener('protocol', async (query) => protocolList()
      .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
      .map((p) => ({ name: p.name, description: p.te ? `${p.bits} bit, TE ${p.te} µs` : `${p.bits} bit`, id: p.name })));
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
}

module.exports = App;
