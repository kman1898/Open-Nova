// app-watch.js - the Monitor tab's own settings and memory (design phase 9): alarm thresholds on top of what the processors
// report (your temperature / voltage limits; a processor's own warning is never lowered), °C / °F, a history of each
// processor's readings (the last hour, in memory only — health is hardware state) drawn as a small graph, the "Bit
// errors" view of the cabinet map, and alerts when a new error comes in: a banner + the tab title always, a beep and a
// desktop notification when switched on (desktop notifications only where the browser allows them: https or this PC).
// Settings are per browser (localStorage 'opennova.watch'), never in the project.
// Owns: WATCH_KEY, watch, watchLoad, watchSave, tempFmt, tempUnit, watchText, watchApply, watchRecord, watchAlert, watchAck,
// watchHistHtml, watchBerFill, watchFormHtml, watchUnit, bindWatch.
// Depends on: app-core ($, esc, toast, ui), app-log (log), app-tips (itip), app-health (hlt, renderHealth, HLT_COL), app-shell (setTab),
// all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var WATCH_KEY = 'opennova.watch';
var watch = {
  set: { tempWarn: 65, tempErr: 80, voltLow: 4.4, unit: 'C', sound: false, notify: false },   // limits in °C / V
  hist: {},        // hist[device id] = [{t, ok, backup, dark, warn, err, tmax, ber}] (last 720 readings)
  alerts: 0,       // errors since the Monitor tab was last looked at
  audio: null
};
function watchLoad() {
  try { var s = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null'); if (s) for (var k in watch.set) if (k in s) watch.set[k] = s[k]; } catch (e) { /* defaults */ }
}
function watchSave() { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watch.set)); } catch (e) { /* private window */ } }
function tempUnit() { return watch.set.unit === 'F' ? '°F' : '°C'; }
// A °C reading in the chosen unit: tempFmt(41.25) -> "41.3 °C" / "106.3 °F"; dec 0 for the map labels.
function tempFmt(t, dec, bare) {
  if (t == null || isNaN(t)) return '—';
  var v = watch.set.unit === 'F' ? t * 9 / 5 + 32 : t;
  return v.toFixed(dec == null ? 1 : dec) + (bare ? '°' : ' ' + tempUnit());
}

// Event wording in the chosen unit ("temperature 68.0 °C" -> "… 154.4 °F"); the log and CSV keep °C.
function watchText(t) {
  return watch.set.unit !== 'F' ? t : String(t).replace(/(-?\d+(?:\.\d+)?) °C/g, function (m, v) { return tempFmt(parseFloat(v)); });
}

// ------------------------------------------------------------------ thresholds (called by hltNorm before events are grouped)
function watchApply(h) {
  var s = watch.set, rank = { ok: 0, warning: 1, error: 2 };
  h.cabinets.forEach(function (c) {
    if (c.dark) return;
    var was = { t: c.tempStatus, v: c.voltStatus };
    if (c.temp != null && c.temp > 0) {
      var t = c.temp >= s.tempErr ? 'error' : c.temp >= s.tempWarn ? 'warning' : 'ok';
      if ((rank[t] || 0) > (rank[c.tempStatus] || 0)) c.tempStatus = t;
    }
    if (c.voltage && s.voltLow && c.voltage < s.voltLow && (rank[c.voltStatus] || 0) < 1) c.voltStatus = 'warning';
    // an event only when our limit raised it (the processor's own warnings already come with an event)
    if (c.tempStatus !== was.t && (rank[c.tempStatus] || 0) > 0)
      h.events.push({ level: c.tempStatus, card: c.card, port: c.port, index: c.index, text: 'temperature ' + c.temp.toFixed(1) + ' °C', mine: true });
    if (c.voltStatus !== was.v)
      h.events.push({ level: 'warning', card: c.card, port: c.port, index: c.index, text: 'supply voltage ' + c.voltage.toFixed(2) + ' V', mine: true });
  });
}

// ------------------------------------------------------------------ history
function watchRecord(d, h) {
  var a = watch.hist[d.id] || (watch.hist[d.id] = []), n = h.sum, tmax = null, ber = 0;
  h.cabinets.forEach(function (c) { if (!c.dark && c.temp) tmax = tmax == null ? c.temp : Math.max(tmax, c.temp); ber += c.bitErrors || 0; });
  a.push({ t: h.at, ok: n.total - n.backup - n.dark, backup: n.backup, dark: n.dark, warn: n.warn, err: n.err, tmax: tmax, ber: ber });
  if (a.length > 720) a.splice(0, a.length - 720);
}
// A small graph per processor: max temperature (line, left scale) and cabinets on backup / dark (bars at the bottom).
function watchHistHtml(d) {
  var a = watch.hist[d.id] || [];
  if (a.length < 2) return '';
  var W = 600, H = 70, t0 = a[0].t, t1 = a[a.length - 1].t, span = Math.max(1, t1 - t0);
  var ts = a.map(function (x) { return x.tmax; }).filter(function (x) { return x != null; });
  var lo = ts.length ? Math.min.apply(null, ts) - 2 : 0, hi = ts.length ? Math.max.apply(null, ts.concat([lo + 10])) + 2 : 1;
  var X = function (t) { return ((t - t0) / span * W).toFixed(1); }, Y = function (v) { return (H - 22 - (v - lo) / (hi - lo) * (H - 30)).toFixed(1); };   // the bottom 16 px are the bars' strip
  var bars = '', most = Math.max.apply(null, a.map(function (x) { return x.dark + x.backup; }).concat([1]));
  a.forEach(function (x, i) {
    if (!x.dark && !x.backup) return;
    var nx = a[i + 1] ? a[i + 1].t : x.t + span / a.length, bw = Math.max(1.5, (nx - x.t) / span * W), bh = (x.dark + x.backup) / most * 14, dh = x.dark / most * 14;
    bars += '<rect x="' + X(x.t) + '" y="' + (H - bh) + '" width="' + bw + '" height="' + (bh - dh) + '" fill="' + HLT_COL.backup + '"/>' +
      (x.dark ? '<rect x="' + X(x.t) + '" y="' + (H - dh) + '" width="' + bw + '" height="' + dh + '" fill="' + HLT_COL.dark + '"/>' : '');
  });
  var line = a.filter(function (x) { return x.tmax != null; }).map(function (x) { return X(x.t) + ',' + Y(x.tmax); }).join(' ');
  var lim = watch.set.tempWarn > lo && watch.set.tempWarn < hi ? '<line x1="0" x2="' + W + '" y1="' + Y(watch.set.tempWarn) + '" y2="' + Y(watch.set.tempWarn) + '" class="wt-lim"/>' : '';
  var last = a[a.length - 1], mins = Math.round(span / 60000);
  return '<div class="wt-hist"><div class="wt-hist-h"><b>History</b><span class="hint">last ' + (mins ? mins + ' min' : Math.round(span / 1000) + ' s') + ' · ' + a.length + ' readings</span><span class="grow"></span>' +
    '<span class="wt-key"><i class="wt-k-t"></i>max temp ' + esc(tempFmt(last.tmax)) + '</span><span class="wt-key"><i style="background:' + HLT_COL.backup + '"></i>on backup</span><span class="wt-key"><i style="background:' + HLT_COL.dark + '"></i>dark</span>' +
    (last.ber ? '<span class="wt-key">bit errors ' + last.ber + '</span>' : '') + '</div>' +
    '<svg class="wt-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Readings over time">' + lim + bars +
    (line ? '<polyline points="' + line + '" class="wt-line"/>' : '') + '</svg></div>';
}

// ------------------------------------------------------------------ bit-error view of the cabinet map
function watchBerFill(x) {
  if (!x || x.missing) return '#3a4252';
  if (x.dark) return HLT_COL.dark;
  var b = x.bitErrors || 0;
  return !b ? HLT_COL.primary : b < 10 ? '#d4a017' : b < 100 ? '#e07a3a' : HLT_COL.error;
}

// ------------------------------------------------------------------ alerts
function watchAlert(entry) {
  if (entry.level !== 'error') return;
  watch.alerts++;
  document.title = '⚠ ' + watch.alerts + ' alarm' + (watch.alerts > 1 ? 's' : '') + ' — ' + (typeof alphaTitleText === 'function' ? alphaTitleText() : 'Open Nova');
  var b = $('wtBanner');
  if (b) { b.hidden = false; $('wtBannerText').textContent = entry.dev + (entry.where ? ' · ' + entry.where : '') + ' · ' + watchText(entry.text) + (watch.alerts > 1 ? '  (+' + (watch.alerts - 1) + ' more)' : ''); }
  if (typeof renderPipe === 'function') renderPipe();   // the Monitor tile flashes (app-pipeline.js)
  var now = Date.now();
  if (now - (watch.lastBeep || 0) < 10000) return;   // one beep / notification per 10 s however many arrive
  watch.lastBeep = now;
  if (watch.set.sound && watch.audio) try {
    [0, 0.22].forEach(function (at) {
      var o = watch.audio.createOscillator(), g = watch.audio.createGain(), t = watch.audio.currentTime + at;
      o.frequency.value = 880; g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g); g.connect(watch.audio.destination); o.start(t); o.stop(t + 0.2);
    });
  } catch (e) { /* no audio */ }
  if (watch.set.notify && window.Notification && Notification.permission === 'granted' && document.hidden)
    try { new Notification('Open Nova alarm', { body: entry.dev + ' · ' + (entry.where ? entry.where + ' · ' : '') + entry.text, tag: 'opennova-alarm' }); } catch (e) { /* not allowed here */ }
}
function watchAck() {
  watch.alerts = 0; document.title = typeof alphaTitleText === 'function' ? alphaTitleText() : 'Open Nova';
  var b = $('wtBanner'); if (b) b.hidden = true;
}

// ------------------------------------------------------------------ the Alarms settings panel
// °C / °F (the Alarms ▾ panel and Settings ▸ Preferences in the menu bar).
function watchUnit(u) {
  if (u !== 'C' && u !== 'F') return;
  watch.set.unit = u; watchSave(); log('monitor_settings', { unit: u });
  var pop = $('wtPop'); if (pop && !pop.hidden) pop.innerHTML = watchFormHtml();
  var hm = $('hmBody'); if (hm) hm.dataset.key = '';   // redraw the map labels
  renderHealth(); if (typeof renderAll === 'function' && hlt.view === 'temp') renderAll();
}
function watchFormHtml() {
  var s = watch.set, f = function (c) { return s.unit === 'F' ? Math.round(c * 9 / 5 + 32) : c; };
  var canNotify = !!window.Notification && window.isSecureContext;
  return '<h4>Alarm limits' + itip('On top of each processor’s own limits — a cabinet goes amber / red at whichever is lower.') + '</h4>' +
    '<div class="wt-row"><span>Temperature warning</span><input type="number" data-wt="tempWarn" value="' + f(s.tempWarn) + '"><span>' + tempUnit() + '</span></div>' +
    '<div class="wt-row"><span>Temperature error</span><input type="number" data-wt="tempErr" value="' + f(s.tempErr) + '"><span>' + tempUnit() + '</span></div>' +
    '<div class="wt-row"><span>Supply voltage below</span><input type="number" step="0.1" data-wt="voltLow" value="' + s.voltLow + '"><span>V</span></div>' +
    '<div class="seg wt-unit"><button data-wtu="C"' + (s.unit === 'C' ? ' class="on"' : '') + '>°C</button><button data-wtu="F"' + (s.unit === 'F' ? ' class="on"' : '') + '>°F</button></div>' +
    '<h4>When an error comes in' + itip('A red banner and the tab title always; a beep and a desktop notification when switched on here.') + '</h4>' +
    '<label class="wt-chk"><input type="checkbox" data-wt="sound"' + (s.sound ? ' checked' : '') + '><span>Beep</span></label>' +
    '<label class="wt-chk"' + (canNotify ? '' : ' title="The browser only allows desktop notifications on https or on this PC (localhost)"') + '><input type="checkbox" data-wt="notify"' + (s.notify && canNotify ? ' checked' : '') + (canNotify ? '' : ' disabled') + '><span>Desktop notification' + (canNotify ? '' : ' <span class="hint">(not on this address)</span>') + '</span></label>';
}
function bindWatch() {
  watchLoad();
  var btn = $('wtBtn'), pop = $('wtPop');
  if (!btn || !pop) return;
  btn.onclick = function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) pop.innerHTML = watchFormHtml(); };
  document.addEventListener('click', function (e) { if (!e.target.closest('#wtPop') && !e.target.closest('#wtBtn')) pop.hidden = true; });
  pop.addEventListener('change', function (e) {
    var i = e.target.closest('[data-wt]'); if (!i) return;
    var k = i.dataset.wt, s = watch.set;
    if (i.type === 'checkbox') {
      s[k] = i.checked;
      if (k === 'sound' && i.checked && !watch.audio) try { watch.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (er) { /* no audio */ }
      if (k === 'notify' && i.checked && Notification.permission === 'default') Notification.requestPermission();
    } else {
      var v = parseFloat(i.value); if (isNaN(v)) return;
      if (k !== 'voltLow' && s.unit === 'F') v = Math.round((v - 32) * 5 / 9 * 10) / 10;
      s[k] = v;
      if (s.tempErr <= s.tempWarn) { toast('The error limit must be above the warning limit'); s.tempErr = s.tempWarn + 5; pop.innerHTML = watchFormHtml(); }
    }
    watchSave(); log('monitor_settings', s); renderHealth();
  });
  pop.addEventListener('click', function (e) {
    var u = e.target.closest('[data-wtu]'); if (u) watchUnit(u.dataset.wtu);
  });
  if (watch.set.sound) document.addEventListener('pointerdown', function first() {   // browsers start audio only after a click
    if (!watch.audio) try { watch.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
    document.removeEventListener('pointerdown', first);
  });
  var bn = $('wtBanner');
  if (bn) bn.onclick = function () { watchAck(); setTab('health'); };
}
