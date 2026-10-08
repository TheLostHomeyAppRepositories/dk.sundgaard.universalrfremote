'use strict';

// Tekster fra den rene logik (fejl og noter) på engelsk og dansk.
// App'en sætter sproget ved start med setLanguage(this.homey.i18n.getLanguage()).

const M = {
  empty_file: { en: 'The file is empty', da: 'Filen er tom' },
  not_flipper: { en: 'Not a Flipper Sub-GHz file', da: 'Ikke en Flipper Sub-GHz-fil' },
  raw_invalid: { en: 'RAW_Data is missing or invalid', da: 'RAW_Data mangler eller er ugyldig' },
  bad_key: { en: 'Invalid key: {key}', da: 'Ugyldig nøgle: {key}' },
  binraw_invalid: { en: 'BinRAW is missing TE or Data_RAW', da: 'BinRAW mangler TE eller Data_RAW' },
  raw_short: { en: 'The RAW recording is too short', da: 'RAW-optagelsen er for kort' },
  raw_nothing: { en: 'No usable signal found in the RAW recording', da: 'Fandt intet brugbart signal i RAW-optagelsen' },
  bad_raw_value: { en: 'Invalid RAW value: {value}', da: 'Ugyldig RAW-værdi: {value}' },
  raw_empty: { en: 'The RAW code is empty', da: 'RAW-koden er tom' },
  fsk: { en: 'The code was recorded with FM/FSK – Homey can only send AM/OOK', da: 'Koden er optaget med FM/FSK – Homey kan kun sende AM/OOK' },
  no_pulses: { en: 'The signal contains no pulses', da: 'Signalet indeholder ingen pulser' },
  frequency: { en: 'Homey can only send on 433.00–433.99 MHz (the code is {mhz} MHz)', da: 'Homey kan kun sende på 433,00–433,99 MHz (koden er {mhz} MHz)' },
  too_long: { en: 'The signal is too long for Homey ({n} intervals, at most {max})', da: 'Signalet er for langt til Homey ({n} intervaller, højst {max})' },
  missing_signal: { en: 'The signal {id} is missing in app.json', da: 'Signalet {id} mangler i app.json' },
  rolling: { en: '{protocol} uses rolling codes and cannot be replayed', da: '{protocol} bruger rullende koder og kan ikke sendes igen' },
  unsupported: { en: '{protocol} is not supported yet – record the button as RAW on the Flipper', da: '{protocol} understøttes ikke endnu – optag knappen som RAW i Flipper' },
  unknown_protocol: { en: 'Unknown protocol: {protocol}', da: 'Ukendt protokol: {protocol}' },
  bits: { en: '{protocol} needs {bits} bits (got {got})', da: '{protocol} kræver {bits} bit (fik {got})' },
  or: { en: 'or', da: 'eller' },
  te_range: { en: 'TE {te} µs is outside {min}–{max} µs', da: 'TE {te} µs er uden for {min}–{max} µs' },
  note_raw: { en: 'RAW: {n} repetition(s) found', da: 'RAW: {n} gentagelse(r) fundet' },
  note_grid: { en: 'rounded to table', da: 'afrundet til tabel' },
  no_buttons: { en: 'Add at least one button', da: 'Tilføj mindst én knap' },
  max_buttons: { en: 'At most {max} buttons', da: 'Højst {max} knapper' },
  no_label: { en: 'Button {n} has no label', da: 'Knap {n} mangler en etiket' },
  pulses: { en: 'pulses', da: 'pulser' },
  no_code: { en: 'The button "{label}" has no code', da: 'Knappen "{label}" mangler en kode' },
};

let lang = 'en';

function setLanguage(l) {
  lang = l === 'da' ? 'da' : 'en';
}

function msg(key, vars = {}) {
  const text = (M[key] && (M[key][lang] || M[key].en)) || key;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const err = (key, vars) => new Error(msg(key, vars));

const getLanguage = () => lang;

module.exports = { setLanguage, getLanguage, msg, err };
