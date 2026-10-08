'use strict';

// Byg-trin (kÃ¸r efter Ã¦ndringer i protokoller, katalog eller views/*.html):
//   node scripts/build.js
// 1. Genererer signals.433 i app.json ud fra lib/radio.js.
// 2. Kopierer views/<side>.html til hver drivers pair/ og repair/.

const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('../lib/radio');

const root = path.join(__dirname, '..');
const file = path.join(root, 'app.json');
const app = JSON.parse(fs.readFileSync(file, 'utf8'));
const signals = buildCatalog();
app.signals = { 433: signals };
// Talarrays pÃ¥ Ã©n linje, ellers bliver filen enorm.
const json = JSON.stringify(app, null, 2)
  .replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  .replace(/\[\s+((?:\[[-\d.,]+\],?\s*)+)\]/g, (m, inner) => `[${inner.replace(/\s+/g, '')}]`);
fs.writeFileSync(file, `${json}\n`);
console.log(`${Object.keys(signals).length} signaler skrevet til app.json`);

for (const driver of app.drivers || []) {
  for (const dir of ['pair', 'repair']) {
    const target = path.join(root, 'drivers', driver.id, dir);
    fs.mkdirSync(target, { recursive: true });
    // Hver driver bruger den side, dens pair-trin peger pÃ¥ (views/<id>.html).
    const view = driver.pair[0].id;
    fs.copyFileSync(path.join(root, 'views', `${view}.html`), path.join(target, `${view}.html`));
  }
}
console.log(`Parringssider kopieret til ${(app.drivers || []).length} drivere`);
