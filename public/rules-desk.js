// Host rules desk: compose typed effects, preview the server's own evaluation, then publish.
// The browser only assembles a small declarative list; all validation and execution is server-side.
import { $, text, node, confirmDialog } from './ui.js?v=1.0.1';

export function createRulesDesk({ getRoom, rpc, send, isLocked }) {
  const desk = { effects: [], catalog: null, proposal: null, corrects: null, caveats: [], previewKey: '', preview: null, busy: false };
  const key = () => JSON.stringify([desk.effects, desk.proposal?.id || null]);
  const catalogEntry = (k) => desk.catalog?.find((c) => c.key === k);

  function describe(e) {
    const when = e.when === 'next_reset' ? ' · at the next midnight reset' : ' · immediately';
    if (e.type === 'set') { const c = catalogEntry(e.key); return `${c?.label || e.key} → ${typeof e.value === 'boolean' ? (e.value ? 'enabled' : 'disabled') : (e.value === 0 && c?.zero ? c.zero : e.value)}${when}`; }
    if (e.type === 'adjust') { const who = e.target === 'living' ? 'Every living player' : getRoom()?.players.find((p) => p.id === e.target)?.name || 'Player';
      return `${who}: ${e.amount > 0 ? '+' : '−'}${Math.abs(e.amount)} ${e.resource}${when}`; }
    if (e.type === 'expire_shields') return 'End all active shields' + when;
    return 'Written rule (host-enforced): ' + e.text;
  }

  function invalidate() { desk.previewKey = ''; desk.preview = null; render(); }
  function reset() { desk.effects = []; desk.proposal = null; desk.corrects = null; desk.caveats = []; $('amendTitle').value = ''; $('amendReason').value = ''; invalidate(); }

  function renderBuilder() {
    const type = $('effectType').value, s = getRoom();
    $('effectSet').hidden = type !== 'set'; $('effectAdjust').hidden = type !== 'adjust'; $('effectWritten').hidden = type !== 'written';
    $('effectWhenWrap').hidden = type === 'written';
    if (type === 'set' && desk.catalog) {
      const c = catalogEntry($('effectKey').value) || desk.catalog[0], current = c.key === 'survivorGoal' ? s.survivorGoal : s.config[c.key];
      const bool = c.type === 'bool';
      $('effectValue').hidden = bool; $('effectToggle').hidden = !bool;
      if (!bool) { $('effectValue').min = c.min; $('effectValue').max = c.max; }
      text('effectKeyNote', `Now: ${bool ? (current ? 'enabled' : 'disabled') : (current === 0 && c.zero ? c.zero : current)}${bool ? '' : ` · allowed ${c.min}–${c.max}${c.zero ? ` (0 = ${c.zero})` : ''}`}. ${c.note || ''}`);
    }
    if (type === 'adjust') {
      const select = $('adjustTarget'), chosen = select.value;
      select.replaceChildren(Object.assign(node('option', 'Every living player'), { value: 'living' }),
        ...s.players.filter((p) => p.alive).map((p) => Object.assign(node('option', p.name), { value: String(p.id) })));
      if ([...select.options].some((o) => o.value === chosen)) select.value = chosen;
    }
  }

  function render() {
    const s = getRoom(); if (!s?.isHost) return;
    const ended = s.phase === 'ended';
    $('rulesDesk').hidden = ended;
    $('effectList').replaceChildren(...(desk.effects.length ? desk.effects.map((e, i) => {
      const li = node('li'), remove = node('button', 'Remove', 'text-button'); remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove effect: ' + describe(e)); remove.onclick = () => { desk.effects.splice(i, 1); invalidate(); };
      li.append(node('span', describe(e)), remove); return li;
    }) : [node('li', 'No effects yet. Add at least one below.', 'hint')]));
    $('deskProposal').hidden = !desk.proposal;
    if (desk.proposal) {
      const cancel = node('button', 'Stop reviewing this proposal', 'text-button'); cancel.type = 'button'; cancel.onclick = reset;
      $('deskProposal').replaceChildren(node('strong', `Approving a proposal by ${desk.proposal.authorName}`),
        node('p', `“${desk.proposal.title}” — ${desk.proposal.body}`), node('p', `${desk.proposal.authorName} pays ${s.config.costProposal} points only if this is published. Payment and effects happen together or not at all.`, 'hint'), cancel);
    }
    $('deskCorrection').hidden = !desk.corrects;
    if (desk.corrects) $('deskCorrection').replaceChildren(node('strong', 'Drafting a correction'), ...desk.caveats.map((c) => node('p', c, 'hint')));
    const fresh = desk.preview && desk.previewKey === key(), p = desk.preview;
    $('amendPreview').hidden = !fresh;
    if (fresh) {
      const box = $('amendPreview'), list = node('ul');
      p.lines.forEach((l) => { const li = node('li'); li.append(node('span', l.when === 'now' ? 'Immediately' : 'Next midnight reset', 'tag'), ...(l.hostEnforced ? [node('span', 'Host-enforced', 'tag tag-warn')] : []), node('span', ' ' + l.text)); list.append(li); });
      box.replaceChildren(node('h3', p.ok ? 'This amendment will:' : 'This amendment cannot be published'), list);
      p.errors.forEach((e) => box.append(node('p', 'Problem: ' + e, 'error')));
      if (p.ok) {
        box.append(node('p', 'Affects: ' + p.affects), node('p', p.changesExisting ? 'Changes existing state: yes — resources, ranges or active shields change as listed.' : 'Changes existing state: no — only future behaviour changes.'));
        if (p.eliminates > 0) box.append(node('p', `Referee only: this eliminates ${p.eliminates} player${p.eliminates === 1 ? '' : 's'} right now.`, 'error'));
        if (p.endsMatchNow) box.append(node('p', 'This ENDS THE MATCH immediately and records the surviving winners.', 'error'));
        if (desk.proposal) box.append(node('p', `Proposer is charged ${p.proposalCost} points on publication.`));
      }
      [...p.warnings, ...p.caveats].forEach((w) => box.append(node('p', 'Note: ' + w, 'hint')));
    }
    $('publishAmend').hidden = !(fresh && p.ok);
    $('publishAmend').textContent = desk.proposal ? 'Approve proposal and publish' : desk.corrects ? 'Publish correction' : 'Publish amendment';
    $('previewAmend').disabled = desk.busy || !desk.effects.length || isLocked(); $('publishAmend').disabled = desk.busy || isLocked();
    renderBuilder();
  }

  async function ensureCatalog() {
    if (desk.catalog) return;
    try {
      desk.catalog = await rpc('tt_rules_catalog', {});
      const groups = new Map();
      desk.catalog.forEach((c) => { if (!groups.has(c.group)) groups.set(c.group, Object.assign(document.createElement('optgroup'), { label: c.group })); groups.get(c.group).append(Object.assign(node('option', c.label), { value: c.key })); });
      $('effectKey').replaceChildren(...groups.values()); render();
    } catch (e) { text('deskFeedback', e?.code === 'PGRST202' ? 'The rules desk needs migration 022 on the server.' : e.message); }
  }

  $('effectType').onchange = renderBuilder; $('effectKey').onchange = renderBuilder;
  $('addEffect').onclick = () => {
    const type = $('effectType').value, when = $('effectWhen').value; let effect;
    if (desk.effects.length >= 12) { text('deskFeedback', 'An amendment holds at most 12 effects.'); return; }
    if (type === 'set') {
      const c = catalogEntry($('effectKey').value); if (!c) return;
      const value = c.type === 'bool' ? $('effectToggle').value === 'true' : Number($('effectValue').value);
      if (c.type !== 'bool' && (!Number.isInteger(value) || $('effectValue').value === '')) { text('deskFeedback', 'Enter a whole number.'); return; }
      effect = { type, key: c.key, value, when };
    } else if (type === 'adjust') {
      const amount = Number($('adjustAmount').value);
      if (!Number.isInteger(amount) || amount < 1 || amount > 50) { text('deskFeedback', 'Enter an amount from 1 to 50.'); return; }
      const target = $('adjustTarget').value;
      effect = { type, resource: $('adjustResource').value, target: target === 'living' ? 'living' : Number(target), amount: amount * Number($('adjustDirection').value), when };
    } else if (type === 'expire_shields') effect = { type, when };
    else { const body = $('writtenText').value.trim(); if (!body) { text('deskFeedback', 'Write the rule first.'); return; } effect = { type, text: body }; $('writtenText').value = ''; }
    text('deskFeedback', ''); desk.effects.push(effect); invalidate();
  };
  $('clearAmend').onclick = reset;
  $('previewAmend').onclick = async () => {
    if (desk.busy || !desk.effects.length) return; desk.busy = true; render();
    try { const k = key(); desk.preview = await rpc('tt_amend_preview', { p_code: getRoom().code, p_effects: desk.effects, p_proposal: desk.proposal?.id || null }); desk.previewKey = k; text('deskFeedback', ''); }
    catch (e) { text('deskFeedback', e.message || 'Preview failed.'); }
    desk.busy = false; render(); $('amendPreview').scrollIntoView({ block: 'nearest' });
  };
  $('publishAmend').onclick = async () => {
    const title = $('amendTitle').value.trim(), reason = $('amendReason').value.trim(), p = desk.preview;
    if (!title || !reason) { text('deskFeedback', 'Add a public title and a public reason first.'); (title ? $('amendReason') : $('amendTitle')).focus(); return; }
    if (!p || desk.previewKey !== key() || !p.ok) return;
    const { confirmed } = await confirmDialog({ title: `Publish “${title}”?`,
      body: p.lines.map((l) => (l.when === 'now' ? '' : 'From the next midnight reset: ') + l.text).join(' '),
      cost: (p.endsMatchNow ? 'THIS ENDS THE MATCH NOW. ' : '') + (desk.proposal ? `${desk.proposal.authorName} is charged ${p.proposalCost} points. ` : '') + 'Everyone in the room will see this amendment and your reason. It cannot be erased, only corrected by a later amendment.',
      label: 'Publish', danger: p.endsMatchNow || p.eliminates > 0 });
    if (!confirmed) return;
    const ok = await send('tt_amend', { p_code: getRoom().code, p_request: crypto.randomUUID(), p_title: title, p_reason: reason, p_effects: desk.effects, p_proposal: desk.proposal?.id || null, p_corrects: desk.corrects });
    if (ok) reset();
  };

  return {
    render, ensureCatalog,
    reviewProposal(q) { reset(); desk.proposal = q; $('amendTitle').value = q.title;
      if (q.kind === 'all_hearts') desk.effects = [{ type: 'adjust', resource: 'hearts', target: 'living', amount: 1, when: 'now' }];
      else if (q.kind === 'last_survivors') desk.effects = [{ type: 'set', key: 'survivorGoal', value: q.survivorCount, when: 'now' }];
      render(); $('rulesDesk').scrollIntoView({ block: 'start' }); $('amendReason').focus(); },
    async draftCorrection(amendment) {
      try { const c = await rpc('tt_amend_correction', { p_code: getRoom().code, p_amendment: amendment.id });
        reset(); desk.corrects = c.id; desk.caveats = c.caveats || []; desk.effects = (c.effects || []).map((e) => ({ ...e, when: 'now' })); $('amendTitle').value = c.title;
        if (!desk.effects.length) desk.caveats = ['Nothing in that amendment can be reversed automatically. Add the effects you want by hand.', ...desk.caveats];
        render(); $('rulesDesk').scrollIntoView({ block: 'start' }); $('amendReason').focus();
      } catch (e) { text('deskFeedback', e.message || 'Could not draft a correction.'); }
    },
  };
}
