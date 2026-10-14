'use strict';

// Tekster fra den rene logik (fejl og noter). De står under "lib" i locales/<sprog>.json –
// de samme filer, Homey selv bruger til this.homey.__ – så hvert sprog vedligeholdes ét sted.
// App'en giver i onInit en funktion, der returnerer Homeys aktuelle sprog, så lib-teksterne altid
// følger samme sprog som parringssiden. Uden den (selvtest) bruges setLanguage. Ukendt sprog → engelsk.

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'locales');

// En ødelagt sprogfil må ikke vælte appen: den springes over, og sproget falder tilbage til engelsk.
const M = {};
const broken = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  try {
    M[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')).lib || {};
  } catch (e) {
    broken.push(`${f}: ${e.message}`);
  }
}
if (!M.en) M.en = {};

let lang = 'en';
let languageSource = null;

function setLanguage(l) {
  lang = M[l] ? l : 'en';
}

// fn() → sprogkode, fx () => this.homey.i18n.getLanguage()
function setLanguageSource(fn) {
  languageSource = fn;
}

function current() {
  if (!languageSource) return lang;
  const l = languageSource();
  return M[l] ? l : 'en';
}

function msg(key, vars = {}) {
  const text = M[current()][key] || M.en[key] || key;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const err = (key, vars) => new Error(msg(key, vars));

// Tal med sprogets decimaltegn, fx "433.92" -> "433,92" på dansk.
const num = (s) => String(s).replace('.', M[current()].decimal || M.en.decimal || '.');

module.exports = {
  setLanguage, setLanguageSource, msg, err, num, locales: M, broken,
};
