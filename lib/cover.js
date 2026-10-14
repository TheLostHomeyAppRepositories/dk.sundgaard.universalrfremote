'use strict';

// Skønnet position for markiser, persienner og gardiner ud fra køretiden.
// Internt er 1 = helt oppe/inde, 0 = helt nede/ude. Skyderen (windowcoverings_set) viser det samme,
// undtagen for markiser, hvor 100 % skal være helt ude – se slider().
// Motoren melder ikke tilbage, så positionen regnes ud fra, hvornår Op/Ned/Stop blev sendt.

const END_MARGIN = 0.02; // så tæt på enden kører vi helt i bund (uden Stop)

class CoverModel {
  constructor(travelMs, position = 1) {
    this.travelMs = travelMs;
    this.position = position;
    this.motion = null; // { dir: +1 op / -1 ned, t0, from }
  }

  at(t) {
    if (!this.motion) return this.position;
    const { dir, t0, from } = this.motion;
    return Math.min(1, Math.max(0, from + (dir * (t - t0)) / this.travelMs));
  }

  start(dir, t) {
    this.position = this.at(t);
    this.motion = { dir, t0: t, from: this.position };
  }

  stop(t) {
    this.position = this.at(t);
    this.motion = null;
  }

  // Tilstand til gemning og fortrydelse. t0 er Date.now(), så en bevægelse overlever en genstart.
  snapshot() {
    return { position: this.position, motion: this.motion && { ...this.motion } };
  }

  restore({ position, motion } = {}) {
    if (typeof position === 'number') this.position = Math.min(1, Math.max(0, position));
    this.motion = motion && [1, -1].includes(motion.dir) ? { ...motion } : null;
  }

  // Samme position og bevægelse med en ny køretid (når indstillingen ændres undervejs).
  retime(travelMs, t) {
    const p = this.at(t);
    const dir = this.motion && this.motion.dir;
    this.travelMs = travelMs;
    this.position = p;
    this.motion = dir ? { dir, t0: t, from: p } : null;
  }

  // Er bevægelsen nået til enden? (så kan den glemmes)
  settle(t) {
    if (this.motion && (this.at(t) === 0 || this.at(t) === 1)) this.stop(t);
  }

  // Hvordan kommer vi til target? -> { dir, ms } hvor ms = null betyder "kør helt i bund",
  // eller null når vi allerede er der.
  plan(target, t) {
    const p = this.at(t);
    const goal = Math.min(1, Math.max(0, Number(target)));
    if (goal >= 1 - END_MARGIN) return p >= 1 && !this.motion ? null : { dir: 1, ms: null };
    if (goal <= END_MARGIN) return p <= 0 && !this.motion ? null : { dir: -1, ms: null };
    if (Math.abs(goal - p) < END_MARGIN) return null;
    return { dir: goal > p ? 1 : -1, ms: Math.round(Math.abs(goal - p) * this.travelMs) };
  }
}

// Intern position <-> skyderens værdi (den samme omregning begge veje).
const INVERTED = ['sunshade'];
const slider = (deviceClass, v) => (INVERTED.includes(deviceClass) ? 1 - v : v);

module.exports = { CoverModel, slider };
