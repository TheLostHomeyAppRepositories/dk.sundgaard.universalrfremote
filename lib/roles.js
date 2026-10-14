'use strict';

// Knapfunktioner: en knap kan kobles til Homeys egne capabilities, så enheden virker som en
// rigtig markise, gardin, garageport, stikkontakt osv. (Homeys kontroller, stemmestyring, zoner).
// Hvilke funktioner der kan vælges, afhænger af enhedstypen.

const COVER = ['up', 'stop', 'down'];
const SWITCH = ['on', 'off', 'toggle'];
const ROLES = {
  sunshade: COVER,
  blinds: COVER,
  curtain: COVER,
  garagedoor: [...COVER, 'toggle'],
  light: SWITCH,
  socket: SWITCH,
  fan: SWITCH,
};
// Alle capabilities, funktionerne kan give (resten af enhedens capabilities er knapperne).
const ROLE_CAPABILITIES = ['onoff', 'windowcoverings_state', 'windowcoverings_set', 'garagedoor_closed'];

const rolesFor = (deviceClass) => ROLES[deviceClass] || [];

// { up: 'b1', stop: 'b2', … } for knapperne med en gyldig funktion
function roleMap(deviceClass, buttons) {
  const valid = rolesFor(deviceClass);
  const map = {};
  for (const b of buttons || []) if (b.role && valid.includes(b.role) && !map[b.role]) map[b.role] = b.id;
  return map;
}

// Capabilities enheden skal have ud fra type, funktioner og køretid (sekunder, 0 = ingen position).
function roleCapabilities(deviceClass, buttons, travelTime = 0) {
  const r = roleMap(deviceClass, buttons);
  const caps = [];
  if (deviceClass === 'garagedoor') {
    if (r.up || r.down || r.toggle) caps.push('garagedoor_closed');
  } else if (ROLES[deviceClass] === COVER) {
    if (r.up || r.down) caps.push('windowcoverings_state');
    // Position kræver begge retninger og Stop, så motoren kan standses undervejs.
    if (travelTime > 0 && r.up && r.down && r.stop) caps.push('windowcoverings_set');
  } else if (ROLES[deviceClass] === SWITCH) {
    if (r.on || r.off || r.toggle) caps.push('onoff');
  }
  return caps;
}

module.exports = {
  ROLES, ROLE_CAPABILITIES, rolesFor, roleMap, roleCapabilities,
};
