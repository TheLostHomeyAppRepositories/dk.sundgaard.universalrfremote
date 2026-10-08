'use strict';

const { prepareCode } = require('./lib/codes');

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  // Til fejlsøgning: body { sub: "<.sub-tekst>" } eller { code: {...} }, valgfrit forceGrid og repetitions.
  async send({ homey, body }) {
    const code = prepareCode(body.sub ? { sub: body.sub } : body.code || {});
    return homey.app.send(code, { forceGrid: !!body.forceGrid, repetitions: body.repetitions });
  },
};
