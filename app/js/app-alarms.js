// app-alarms.js - what a Monitor event means and what to do about it (design phase 9), for every processor family: the
// readers (novalink health, unicolink health, coexlink health) word their events the same way, and this catalogue maps
// the wording to a cause and a suggestion (from NovaStar's own alarm help in Unico / VMP / NovaLCT: docs\HEALTH_UNICO.md,
// HEALTH_VMP.md, HEALTH_LCT.md). Also: the event list as CSV.
// Owns: ALARMS, alarmInfo, alarmsCsv, alarmsDownload.
// Depends on: app-core (P, esc), app-health (hlt), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// [pattern on the event text, cause, suggestion]
var ALARMS = [
  [/^cleared/, 'The condition stopped.', 'Nothing to do; check the wall if it keeps coming back.'],
  [/primary (port )?failed|primary failed/, 'The primary cable or port carries no data, so the whole chain is fed from the backup port.', 'Check the primary cable, its connectors and the port on the processor. The picture is safe while the backup holds.'],
  [/data break before cabinet|data link broken|split feed/, 'The chain is broken between two cabinets: those before the break are fed from the primary port, the rest from the backup.', 'Check the network cable between the named cabinet and the one before it, and both cards’ ports. Without backup the cabinets after the break would be dark.'],
  [/redundancy lost|backup port \d+ has no link/, 'The backup cable isn’t connected or carries nothing, so there is no spare if the primary fails.', 'Plug the backup cable into the last cabinet of the chain and the backup port; then Verify on the Backup tab.'],
  [/not answering on either side|dark/, 'Cabinets answer on neither the primary nor the backup side: no power, a dead receiving card, or both cables broken.', 'Check the cabinets’ power and the receiving card LEDs; swap the card if it stays dark.'],
  [/port disconnected/, 'A port that drives cabinets has no link.', 'Check the cable and the first cabinet’s power. If the port has a backup, see whether the picture is on backup.'],
  [/fibre disconnected/, 'The fibre link to the converter / fibre card is down.', 'Check the fibre, its connectors and the converter’s power.'],
  [/running on backup|fed from backup/, 'Cabinets are fed from the backup port.', 'The primary path has a fault; find it before the backup fails too.'],
  [/temperature high|temperature [\d.]+ °[cf]/,'A receiving card reports a high temperature.', 'Check ventilation and fans, sun load and the cabinet’s brightness; lower brightness if needed.'],
  [/temperature low/, 'A receiving card reports a low temperature.', 'Let the wall warm up before full brightness; check the heating if any.'],
  [/voltage high/, 'The supply voltage at the receiving card is above its range.', 'Check the cabinet’s power supply setting and replace it if it drifts.'],
  [/voltage low|supply voltage/, 'The supply voltage at the receiving card is outside its range.', 'Check the power supply and its wiring; a weak supply causes flicker and resets.'],
  [/bit errors on backup/, 'Data errors on the backup side of the chain.', 'Check the backup cable and connectors.'],
  [/bit errors on primary|bit errors/, 'Packets are being lost or corrupted on the network cable.', 'Re-seat or replace the cable at the named cabinet; check the cable length and quality. Clear the counter after fixing it.'],
  [/power supply .*failed/, 'One of the cabinet’s power supplies reports a failure (dual-supply cabinets run on the other one).', 'Replace the failed supply soon and check its mains feed; the cabinet has no spare left meanwhile.'],
  [/over capacity/, 'The port carries more pixels than it can.', 'Move cabinets to another port (Layout) and Send again.'],
  [/unstable|non-standard/, 'The port’s link is unstable or not a standard Ethernet link.', 'Check the cable and the switch / converter in between, if any.']
];
function alarmInfo(text) {
  var t = String(text || '').toLowerCase();
  for (var i = 0; i < ALARMS.length; i++) if (ALARMS[i][0].test(t)) return { cause: ALARMS[i][1], suggestion: ALARMS[i][2] };
  return null;
}
function alarmsCsv() {
  var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var rows = [['time', 'ended', 'level', 'processor', 'where', 'event', 'times', 'cause', 'suggestion']];   // the errors kept until Clear (app-health)
  hlt.log.forEach(function (e) { var a = alarmInfo(e.text) || {}; rows.push([new Date(e.t).toISOString(), e.ended ? new Date(e.ended).toISOString() : '', e.level, e.dev, e.where, e.text, e.n || 1, a.cause, a.suggestion]); });
  return rows.map(function (r) { return r.map(q).join(','); }).join('\r\n');
}
function alarmsDownload() {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([alarmsCsv()], { type: 'text/csv' }));
  a.download = (P.name || 'project').replace(/[^\w.-]+/g, '_') + '_events.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
