'use strict';

const { prepareCode } = require('./lib/codes');

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  // Til fejlsøgning: body { seconds } – lyt og dekod som lyt-fanen; svarer når en kode er fundet.
  async listen({ homey, body }) {
    return homey.app.listen({ seconds: body && body.seconds });
  },

  // Til fejlsøgning: body { sub: "<.sub-tekst>" } eller { code: {...} }, valgfrit forceGrid og repetitions.
  async send({ homey, body }) {
    const code = prepareCode(body.sub ? { sub: body.sub } : body.code || {});
    return homey.app.send(code, { forceGrid: !!body.forceGrid, repetitions: body.repetitions });
  },
};
