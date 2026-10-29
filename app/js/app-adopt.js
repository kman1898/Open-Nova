// app-adopt.js - adopt detected hardware (design phase 10): when the processor a project processor is linked to is another
// model, or (H series) has other output cards, one click makes the project match it — the wiring stays on the same card
// and port numbers, and the change is refused (with the reason) when a wired port wouldn't exist any more.
// Read-only towards the processor: it only changes the project (undoable).
// Unico / COEX report their model; a NovaLCT link reports its sending cards: on H series those are the output cards
// (the chassis itself isn't named on the link: the H's web API names it when its login is saved, else the smallest H chassis
// that holds them is proposed when the project's doesn't),
// otherwise the processor model of the first card.
// Owns: adoptTarget, adoptHtml, hwAdopt.
// Depends on: app-core (P, esc, toast, commit), app-log (log), app-processors (PROC_MODELS, PROC_ORDER, OUTPUT_CARDS,
// procModel, cardsOfDevice, cardTypeLabel, deviceLabel, wiredCards, cardList, applyCards, cardChangeToast,
// setProcessorModel), app-hardware (hwModelKey), app-render (renderAll), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// What the linked processor is, where it differs from the project: {model, types|null, changes[], notes[]}; null = same.
function adoptTarget(d) {
  if (!d || !d.hw || d.hw.kind === 'offline') return null;
  var t = { model: d.model, types: null, changes: [], notes: [] }, idx = cardsOfDevice(d);
  if (d.hw.kind === 'unico' || d.hw.kind === 'coex') {
    var k = hwModelKey(d.hw.modelId); if (!k) return null;   // a model the catalogue doesn't know: nothing to adopt
    t.model = k;
  } else {
    var S = d.hw.senders || []; if (!S.length) return null;
    var types = S.map(function (id) { return Object.keys(OUTPUT_CARDS).filter(function (x) { return OUTPUT_CARDS[x].modelId === id; })[0]; });
    if (types.every(Boolean)) {
      var fits = function (key) {
        var x = PROC_MODELS[key];
        return x && x.kind === 'chassis' && x.slots >= S.length && types.every(function (ty) { return x.cardTypes.indexOf(ty) >= 0; });
      };
      var wk = d.hw.web && hwModelKey(d.hw.web.modelId);   // the chassis the H's web API reported (app-online.js)
      if (wk && fits(wk)) t.model = wk;
      else if (!fits(d.model)) {
        t.model = PROC_ORDER.filter(fits)[0];
        if (!t.model) return null;
        t.notes.push('The link names its output cards, not the chassis: ' + PROC_MODELS[t.model].name + ' is the smallest that holds them — H login… (Hardware) reads the real one.');
      }
      t.types = types;
    } else {
      var k2 = hwModelKey(S[0]); if (!k2) return null;
      t.model = k2;
      var m2 = procModel(k2);
      if (m2.kind === 'fixed' && S.length !== idx.length)
        t.notes.push('The link has ' + S.length + ' cascaded unit' + (S.length > 1 ? 's' : '') + '; ' + deviceLabel(d) + ' has ' + idx.length + ' — add or remove cascaded processors in Processors.');
    }
  }
  if (t.model !== d.model) t.changes.push(procModel(d.model).name + ' → ' + PROC_MODELS[t.model].name);
  if (t.types) {
    if (idx.length !== t.types.length) t.changes.push(idx.length + ' → ' + t.types.length + ' output card' + (t.types.length > 1 ? 's' : ''));
    t.types.forEach(function (ty, i) {
      var c = P.processors[idx[i]];
      if (c && c.type !== ty) t.changes.push('output card ' + (i + 1) + ': ' + (cardTypeLabel(c) || procModel(d.model).name + ' card') + ' → ' + OUTPUT_CARDS[ty].name);
    });
  }
  return t.changes.length ? t : null;
}
// The Hardware card's notice (empty when the project matches the processor).
function adoptHtml(d) {
  var t = adoptTarget(d); if (!t) return '';
  return '<div class="hw-adopt"><b>The processor differs from the project</b><br><span>' + t.changes.map(esc).join(' · ') + '</span>' +
    '<div class="row"><button class="mini primary" data-hw="adopt" title="Change the project to what the processor really is; wiring stays on the same card / port numbers (undo with Ctrl+Z)">Adopt hardware</button></div></div>';
}
function hwAdopt(d) {
  var t = adoptTarget(d); if (!t) return toast('The project already matches ' + (d.hw ? d.hw.name : 'the processor'));
  if (!confirm('Make ' + deviceLabel(d) + ' match ' + d.hw.name + '?\n\n• ' + t.changes.join('\n• ') + (t.notes.length ? '\n\n' + t.notes.join('\n') : '') +
    '\n\nThe wiring stays on the same card and port numbers. Undo with Ctrl+Z.')) return;
  if (!t.types) { setProcessorModel(d, t.model); log('hw_adopt', { processor: deviceLabel(d), to: PROC_MODELS[t.model].name }); return; }
  // H series: the chassis and its output cards as detected
  var idx = cardsOfDevice(d), wired = wiredCards(), bad = [];
  var fresh = t.types.map(function (ty, k) { return { ports: OUTPUT_CARDS[ty].ports, type: ty, dev: d.id, old: idx[k] != null ? idx[k] : null }; });
  idx.forEach(function (i, k) {
    if (!wired[i]) return;
    if (!fresh[k]) bad.push(cardName(i, true) + ' has cabinets but the processor has only ' + fresh.length + ' output card' + (fresh.length > 1 ? 's' : ''));
    else if (fresh[k].ports < wired[i]) bad.push(cardName(i, true) + ' uses port ' + wired[i] + ' but the ' + OUTPUT_CARDS[fresh[k].type].name + ' there has ' + fresh[k].ports);
  });
  if (bad.length) { log('hw_adopt', { processor: deviceLabel(d), refused: bad }); return toast('Can’t adopt: ' + bad.join('; ') + ' — move those cabinets first'); }
  var before = deviceLabel(d), cards = cardList(), at = idx[0];
  cards.splice(at, idx.length);   // a processor's cards are consecutive
  Array.prototype.splice.apply(cards, [at, 0].concat(fresh));
  d.model = t.model;
  var pinned = applyCards(cards);
  log('hw_adopt', { processor: before, to: PROC_MODELS[t.model].name, cards: t.types.map(function (ty) { return OUTPUT_CARDS[ty].name; }) });
  commit(); renderAll();
  cardChangeToast(before + ' now matches ' + d.hw.name + ': ' + t.changes.join(' · ') + (idx.length !== fresh.length && at + idx.length < P.processors.length ? '; later cards were renumbered' : ''), pinned);
}
