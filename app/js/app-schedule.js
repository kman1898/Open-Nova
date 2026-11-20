// app-schedule.js - the Schedule tab (design phase 11; Unico / VMP "Schedule"): brightness by time of day, stored and run by
// the processor itself, so the app doesn't have to stay open.
//   - COEX (MX / CX): list, add (one-off or weekly), delete, and the screen's Schedule switch (strategies only run while it
//     is on; VMP leaves it off) — all checked on VMP's controller emulator (docs\PRESET_SCHEDULE_API.md §2.2).
//   - Unico (VX Pro): the list, read-only (its add / delete bodies weren't seen live yet).
//   - NovaLCT processors have no scheduler of their own: said so, nothing offered.
// Owns: sch, SCH_DAYS, schLoad, schRun, schAct, renderSchedule, bindSchedule.
// Depends on: app-core (P, ui, $, esc, toast), app-log (log), app-processors (deviceLabel, procModel), drv-core (DRV),
// all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var sch = {};   // sch[devId] = { busy, error, enable, brightness: [{id, start, end, brightness, repeat, until}] }
var SCH_DAYS = [[1, 'Mo'], [2, 'Tu'], [3, 'We'], [4, 'Th'], [5, 'Fr'], [6, 'Sa'], [0, 'Su']];

function schLoad(d) {
  var e = sch[d.id] = sch[d.id] || {}; e.busy = true; renderSchedule();
  return DRV.of(d).schedules(d).then(function (r) { return r; }, function (x) { return { ok: false, error: 'helper: ' + x.message }; }).then(function (r) {
    e.busy = false; e.error = r.ok ? '' : r.error;
    if (r.ok) { e.enable = r.enable; e.brightness = r.brightness; e.presetCount = r.presetCount; e.diagnosticsCount = r.diagnosticsCount; }
    renderSchedule();
  });
}
function schRun(d, what, call) {
  var e = sch[d.id] = sch[d.id] || {}; e.busy = true; renderSchedule();
  return call.then(function (r) { return r; }, function (x) { return { ok: false, error: 'helper: ' + x.message }; }).then(function (r) {
    log('schedule', { processor: deviceLabel(d), what: what, ok: !!r.ok, error: r.error });
    toast(r.ok ? deviceLabel(d) + ': ' + what : '⚠ ' + deviceLabel(d) + ': ' + what + ' failed — ' + r.error);
    return schLoad(d);
  });
}
function schAct(d, act, el) {
  var x = DRV.of(d), e = sch[d.id] || {};
  if (act === 'refresh') return schLoad(d);
  if (act === 'enable') {   // it changes what the processor does by itself from now on: ask, like add / delete
    if (!confirm('Turn the schedule ' + (e.enable ? 'off' : 'on') + ' on ' + deviceLabel(d) + '?\n\n' + (e.enable ? 'Its brightness strategies stop running.' : 'Its brightness strategies start running by themselves at their times.'))) return;
    return schRun(d, 'schedule ' + (e.enable ? 'off' : 'on'), x.scheduleEnable(d, !e.enable));
  }
  if (act === 'delete') {
    var it = (e.brightness || []).filter(function (q) { return String(q.id) === el.dataset.id; })[0]; if (!it) return;
    if (!confirm('Delete the brightness schedule ' + it.start + ' – ' + it.end.slice(-5) + ' (' + it.brightness + ' %) from ' + deviceLabel(d) + '?')) return;
    return schRun(d, 'schedule deleted', x.scheduleDelete(d, it.id));
  }
  if (act === 'add') {
    var f = el.closest('.sh-form'), q = function (n) { return f.querySelector('[name="' + n + '"]'); };
    var date = q('date').value, t0 = q('from').value, t1 = q('to').value, br = +q('br').value;
    var days = Array.prototype.filter.call(f.querySelectorAll('[name="day"]'), function (c) { return c.checked; }).map(function (c) { return +c.value; });
    if (!date || !t0 || !t1) return toast('Pick the date and both times');
    if (t1 <= t0) return toast('The end time must be after the start time');
    if (!(br >= 0 && br <= 100)) return toast('Brightness is 0–100 %');
    if (!confirm('Add on ' + deviceLabel(d) + ': brightness ' + br + ' % from ' + t0 + ' to ' + t1 + (days.length ? ' every ' + SCH_DAYS.filter(function (x) { return days.indexOf(x[0]) >= 0; }).map(function (x) { return x[1]; }).join(' ') + ' from ' + date : ' on ' + date) +
      '?' + (e.enable ? '' : '\n\nThe processor’s Schedule switch is off: turn it on for the schedule to run.'))) return;
    return schRun(d, 'brightness schedule added', x.scheduleAdd(d, { start: date + ' ' + t0, end: date + ' ' + t1, brightness: br, repeat: days }));
  }
}
function renderSchedule() {
  var box = $('shBody'); if (!box || ui.tab !== 'schedule') return;
  // someone is typing in the add form: a redraw (live polling calls renderAll) would wipe it — draw later
  var a = document.activeElement;
  if (a && box.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { if (!renderSchedule.later) renderSchedule.later = setTimeout(function () { renderSchedule.later = 0; renderSchedule(); }, 1500); return; }
  var linked = (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).filter(function (d) { return d.hw; });   // online: the connected ones (app-online.js)
  if (!linked.length) { box.innerHTML = '<p class="hint">No processor is linked. Link one in Device → Hardware.</p>'; return; }
  var today = new Date(), iso = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
  // the processors without a scheduler: one line for all of them (UI cleanup item 10), not a card each
  var none = linked.filter(function (d) { return !DRV.caps(d).schedule; });   // a simulated VX Pro / MX keeps its schedules in memory (drv-offline.js)
  linked = linked.filter(function (d) { return none.indexOf(d) < 0; });
  box.innerHTML = (none.length ? '<p class="hint sh-none">' + esc(none.map(deviceLabel).join(', ')) + ': no scheduler on ' + (none.length === 1 ? 'this processor' : 'these processors') + ' — recall scenes by hand.' +
    itip('NovaLCT-protocol processors (MCTRL, VX, H series …) have no scheduler of their own. Scenes (Preset tab) can still be recalled by hand.') + '</p>' : '') + linked.map(function (d) {
    var c = DRV.caps(d).schedule, h = '<div class="ps-scene"><h3>' + esc(deviceLabel(d)) + ' <span class="hint">' + esc(procModel(d.model).name) + (DRV.caps(d).simulated ? ' · simulated' : '') + '</span><span class="grow"></span>';
    var e = sch[d.id];
    if (!e) { setTimeout(function () { schLoad(d); }, 0); e = { busy: true }; }
    h += (c.enable ? '<button class="mini' + (e.enable ? ' primary' : '') + '" data-sh="enable" data-dev="' + d.id + '"' + (e.busy ? ' disabled' : '') + ' title="The processor runs its schedules only while this is on">Schedule ' + (e.enable ? 'on' : 'off') + '</button>' :
      (e.enable != null ? '<span class="hint">Schedule ' + (e.enable ? 'on' : 'off') + '</span>' : '')) +
      '<button class="mini" data-sh="refresh" data-dev="' + d.id + '"' + (e.busy ? ' disabled' : '') + '>' + (e.busy ? '…' : 'Refresh') + '</button></h3>';
    if (e.error) h += '<p class="rd-msg err">' + esc(e.error) + '</p>';
    var list = e.brightness || [];
    h += list.length ? '<table><tr><th>From</th><th>To</th><th>Brightness</th><th>Repeat</th><th></th></tr>' + list.map(function (q) {
      return '<tr><td>' + esc(q.start) + '</td><td>' + esc(q.end) + '</td><td>' + (q.sensor ? 'light sensor' : q.brightness + ' %') + '</td><td>' +
        (q.repeat && q.repeat.length ? SCH_DAYS.filter(function (x) { return q.repeat.indexOf(x[0]) >= 0; }).map(function (x) { return x[1]; }).join(' ') : 'once') + '</td><td style="text-align:right">' +
        (c.remove ? '<button class="mini" data-sh="delete" data-dev="' + d.id + '" data-id="' + esc(q.id) + '">×</button>' : '') + '</td></tr>';
    }).join('') + '</table>' : (e.busy ? '' : '<p class="hint">No brightness schedules.</p>');
    if (e.presetCount || e.diagnosticsCount) h += '<p class="hint">Also on the processor: ' + [e.presetCount ? e.presetCount + ' preset schedule(s)' : '', e.diagnosticsCount ? e.diagnosticsCount + ' diagnostics schedule(s)' : ''].filter(Boolean).join(', ') + ' (edit them in its own app for now).</p>';
    if (c.add) h += '<div class="sh-form"><label>Date<input type="date" name="date" value="' + iso + '"></label><label>From<input type="time" name="from" value="20:00"></label>' +
      '<label>To<input type="time" name="to" value="23:00"></label><label>Brightness %<input type="number" name="br" min="0" max="100" value="50"></label>' +
      '<span class="sh-days">Repeat: ' + SCH_DAYS.map(function (x) { return '<label><input type="checkbox" name="day" value="' + x[0] + '">' + x[1] + '</label>'; }).join('') + '</span>' +
      '<button class="primary" data-sh="add" data-dev="' + d.id + '"' + (e.busy ? ' disabled' : '') + '>Add…</button></div>';
    else h += '<p class="hint">Read-only here' + itip('Adding schedules from Open Nova comes once its calls are checked live; use the processor’s own app for now.') + '</p>';
    return h + '</div>';
  }).join('');
}
function bindSchedule() {
  var box = $('shBody'); if (!box) return;
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-sh]'); if (!b) return;
    var d = P.devices.filter(function (x) { return x.id === b.dataset.dev; })[0]; if (d) schAct(d, b.dataset.sh, b);
  });
  box.addEventListener('keydown', function (e) { e.stopPropagation(); });   // typing in the form isn't a canvas shortcut
}
