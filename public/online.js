// Turn Tactics client. The server is the only authority: this file renders server snapshots and
// sends explicit, idempotent requests. Nothing here decides a game outcome.
import { $, text, node, plural, icon, hydrateIcons, safeIcon, confirmDialog, copyText } from './ui.js?v=1.0.1';
import { crestElement, crestName, square, fileLabel, rankLabel } from './crest.js?v=1.0.1';
import { createChat } from './chat.js?v=1.0.1';
import { createAccount } from './account.js?v=1.0.1';
import { createNotifications } from './notify.js?v=1.0.1';
import { createRulesDesk } from './rules-desk.js?v=1.0.1';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './online-config.js';

const APP_VERSION = '1.0.1';
const CURRENT_RULES = 'owner-2026-11';
const state = { db: null, room: null, busy: false, pending: null, view: 'field', selected: null, cell: null, focus: null, zoom: null,
  stale: false, icon: null, iconReading: false, iconVersion: 0, boardKey: '', centerPending: false, account: null };
let chat = null, accounts = null, notifications = null, desk = null, menuReturn = null;
const wide = matchMedia('(min-width: 1024px)');
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };
try { state.pending = JSON.parse(sessionStorage.getItem('tt-online-pending') || 'null'); } catch { /* none */ }

const me = () => state.room?.players.find((p) => p.id === state.room.me);
const locked = () => state.busy || !!state.pending;
// A server that has not run migration 022 yet sends no `config`; fall back to that room's known values.
const config = (s = state.room) => s?.config || { costMove: 1, costAttack: 1, costShield: 2, costRange: 2, costProposal: s?.proposalCost ?? 4, dailyIncome: 1, voteBonus: 1,
  baseRange: s?.baseRange ?? 2, maxRange: 0, moveLimit: 0, shieldDays: 1, cutoffHour: s?.cutoffHour ?? 19, allowMove: true, allowAttack: true, allowGive: true, allowShield: true, allowRange: true, forfeitOnElimination: s?.rulesVersion !== 'legacy-v0.5' };
const pts = (n) => plural(n, 'point');
const hourText = (h) => (h === 24 ? 'midnight' : `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`);
const where = (p) => square(p.x, p.y, state.room.size);

// ---------- requests ----------
const RETRYABLE = new Set(['tt_command', 'tt_set_icon', 'tt_propose', 'tt_propose_survivors', 'tt_review', 'tt_save_recovery', 'tt_recover', 'tt_amend', 'tt_amend_cancel', 'tt_migrate_rules', 'tt_delete_room']);
const FEEDBACK = { tt_set_icon: 'iconFeedback', tt_save_recovery: 'recoveryFeedback', tt_propose: 'proposalFeedback', tt_propose_survivors: 'proposalFeedback',
  tt_review: 'deskFeedback', tt_amend: 'deskFeedback', tt_amend_cancel: 'deskFeedback', tt_migrate_rules: 'deskFeedback', tt_delete_room: 'deskFeedback', tt_set_room_name: 'accountFeedback',
  tt_join: 'homeFeedback', tt_create: 'homeFeedback', tt_recover: 'homeFeedback' };
function stash(p) { state.pending = p; try { if (p) sessionStorage.setItem('tt-online-pending', JSON.stringify(p)); else sessionStorage.removeItem('tt-online-pending'); } catch { /* storage unavailable */ } }
let noticeTimer;
function notice(message, target) {
  clearTimeout(noticeTimer); text('requestText', message); $('requestStatus').hidden = false; $('retry').hidden = !state.pending; $('dismissStatus').hidden = !!state.pending;
  if (target) text(target, message);
  // An unconfirmed request stays on screen until it is resolved; ordinary confirmations fade.
  if (!state.pending) noticeTimer = setTimeout(() => { $('requestStatus').hidden = true; }, 6000);
}
async function rpc(name, args) { const { data, error } = await state.db.rpc(name, args); if (error) throw error; return data; }

/** Sends one explicit request. Returns true only when the server confirmed it. */
async function send(name, args) {
  if (state.busy || !state.db) return false;
  const target = FEEDBACK[name] || (name === 'tt_command' ? (state.room?.isHost ? 'deskFeedback' : 'actionFeedback') : 'homeFeedback');
  if (RETRYABLE.has(name)) stash({ name, args });
  state.busy = true; updateControls(); notice('Waiting for the server…', target);
  try {
    const result = await rpc(name, args); stash(null);
    if (result?.error) { notice(result.error, target); return false; }
    if (result?.deleted) { leaveRoom('The finished room was deleted.'); return true; }
    state.stale = false; render(result); remember(result);
    let message = 'Confirmed by the server.';
    if (name === 'tt_set_icon') { state.icon = null; $('iconPreviewBox').hidden = true; message = 'Your image is locked for this game.'; }
    if (name === 'tt_propose' || name === 'tt_propose_survivors') { $('proposalForm').reset(); updateProposalForm(); message = 'Proposal sent. No points charged.'; }
    if (name === 'tt_save_recovery') { $('privateRecovery').value = args.p_token; $('recoveryOutput').hidden = false; message = 'Recovery code created. Save it privately before leaving.'; }
    if (name === 'tt_recover') { $('recoverToken').value = ''; message = 'Role restored to this account. The previous identity no longer controls it.'; }
    if (['tt_join', 'tt_create', 'tt_recover'].includes(name)) go('field');
    notice(message, target); return true;
  } catch (e) {
    // No error code means no answer arrived: keep the request so the SAME one can be retried safely.
    if (RETRYABLE.has(name) && !e.code) { stash({ name, args }); notice('No confirmation arrived. Do not repeat the action — retry this same request instead.', target); }
    else { stash(null); notice(e.message || 'The server could not complete this request.', target); }
    return false;
  } finally { state.busy = false; updateControls(); }
}
const command = (action, extra = {}) => (!locked() && state.room ? send('tt_command', { p_code: state.room.code, p_request: crypto.randomUUID(), p_action: action, ...extra }) : false);

function remember(s) {
  store.set('tt-online-room', s.code);
  let list = []; try { list = JSON.parse(store.get('tt-rooms') || '[]'); } catch { /* reset */ }
  list = [{ code: s.code, invite: s.invite || null, role: s.isHost ? 'Host' : 'Player' }, ...list.filter((r) => r.code !== s.code)].slice(0, 8);
  store.set('tt-rooms', JSON.stringify(list));
}
function forget(code) {
  let list = []; try { list = JSON.parse(store.get('tt-rooms') || '[]'); } catch { /* reset */ }
  store.set('tt-rooms', JSON.stringify(list.filter((r) => r.code !== code)));
  if (store.get('tt-online-room') === code) store.set('tt-online-room', null);
}
async function openRoom(code, view) {
  try { render(await rpc('tt_view', { p_code: code })); remember(state.room); go(view || 'field'); return true; }
  catch (e) { text('homeFeedback', /unavailable/i.test(e.message || '') ? 'That room is no longer available to this account. It may have been deleted, or its role restored elsewhere.' : 'Could not reopen that room right now.'); if (/unavailable/i.test(e.message || '')) { forget(code); renderHome(); } return false; }
}
function leaveRoom(message) {
  state.room = null; state.selected = null; state.cell = null; state.boardKey = ''; chat?.onRoom(null);
  $('roomBadge').hidden = true; $('privateRecovery').value = ''; $('recoveryOutput').hidden = true; $('hostLog').replaceChildren();
  store.set('tt-online-room', null); renderHome(); renderSettings(); go('field'); if (message) text('homeFeedback', message);
}
async function refresh() {
  if (!state.room || locked() || document.hidden) return;
  try { render(await rpc('tt_view', { p_code: state.room.code })); }
  catch (e) {
    if (e.code && /unavailable/i.test(e.message || '')) { const code = state.room.code; forget(code); leaveRoom('That room is no longer available to this account.'); return; }
    state.stale = true; $('staleBanner').hidden = false; setConnection('Reconnecting', false); renderInspector(); updateControls();
  }
}
function setConnection(label, live) { text('connection', label); $('connection').classList.toggle('live', live); }

// ---------- navigation ----------
function go(view) {
  const s = state.room;
  if (view === 'desk' && !s?.isHost) view = 'field';
  if (!s && view !== 'settings') view = 'field';
  state.view = view; closeMenu(false);
  const shown = !s && view === 'field' ? 'home' : view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + shown; });
  document.querySelectorAll('#menu [data-view]').forEach((b) => {
    const current = b.dataset.view === view; b.classList.toggle('active', current);
    if (current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    b.hidden = b.dataset.view === 'desk' ? !s?.isHost : !s && !['field', 'settings'].includes(b.dataset.view);
  });
  document.querySelector('#menu [data-view="field"] span:last-child').textContent = s ? 'Field' : 'Home';
  document.body.dataset.view = shown;
  chat?.setActive(view === 'chat' && !!s);
  if (view === 'chat' && !state.pending) $('requestStatus').hidden = true;
  if (view === 'field' && s) requestAnimationFrame(renderBoard);
  if (view === 'desk') { desk.ensureCatalog(); desk.render(); }
  if (view === 'settings') notifications.render();
  document.title = (s ? ({ field: 'Field', chat: 'Chat', council: 'Rules & Council', players: 'Players', dispatch: 'Official Dispatch', settings: 'Settings', desk: 'Host desk' })[view] : view === 'settings' ? 'Settings' : 'Home') + ' · Turn Tactics';
}
function openMenu() {
  if (wide.matches) return;
  menuReturn = document.activeElement; document.body.classList.add('menu-open'); $('menu').inert = false; $('menuScrim').hidden = false;
  $('menuButton').setAttribute('aria-expanded', 'true'); ($('menu').querySelector('.active:not([hidden])') || $('menuClose')).focus();
}
function closeMenu(restoreFocus = true) {
  if (!document.body.classList.contains('menu-open')) { $('menu').inert = !wide.matches; return; }
  document.body.classList.remove('menu-open'); $('menuScrim').hidden = true; $('menu').inert = !wide.matches; $('menuButton').setAttribute('aria-expanded', 'false');
  if (restoreFocus) (menuReturn || $('menuButton')).focus();
}
$('menuButton').onclick = openMenu; $('menuClose').onclick = () => closeMenu(); $('menuScrim').onclick = () => closeMenu();
$('menu').addEventListener('keydown', (e) => {
  if (wide.matches) return;
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
  if (e.key !== 'Tab') return; // keep focus inside the open panel
  const items = [...$('menu').querySelectorAll('button:not([hidden])')], first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
wide.addEventListener('change', () => closeMenu(false));
document.querySelectorAll('#menu [data-view]').forEach((b) => { b.onclick = () => { go(b.dataset.view); $('main').focus({ preventScroll: true }); }; });

// ---------- shared pieces ----------
function avatar(seat, labelled = false) {
  const a = node('span', undefined, 'avatar'), s = state.room;
  if (seat === -1) { a.classList.add('avatar-host'); a.append(icon('desk', labelled ? 'Host' : undefined)); return a; }
  const p = s?.players.find((x) => x.id === seat);
  if (!p) return a;
  if (safeIcon(p.icon)) { const img = document.createElement('img'); img.src = p.icon; img.alt = labelled ? p.name + '’s image' : ''; img.decoding = 'async'; img.onerror = () => { img.replaceWith(crestElement(s.code, p.id)); }; a.append(img); }
  else a.append(crestElement(s.code, p.id, labelled ? `${p.name}’s crest: ${crestName(s.code, p.id)}` : undefined));
  return a;
}
function clockText(s) {
  if (s.phase === 'ended') return 'The result is final.';
  if (s.isTest) return 'Test room · the host advances the day.';
  if (s.phase === 'lobby') return 'Opens at the Pacific midnight after the host schedules it.';
  if (s.phase === 'scheduled') return `Opens ${s.nextReset || 'at the next'} · 12:00 am Pacific`;
  const cutoff = config(s).cutoffHour;
  return s.closed ? 'Actions reopen at midnight Pacific.' : cutoff === 24 ? 'Actions open all day (Pacific).' : `Actions open until ${hourText(cutoff)} Pacific.`;
}

// ---------- render ----------
function render(s) {
  if (!s || !Array.isArray(s.players)) throw Error('Unexpected server response. Do not repeat a pending action.');
  const previous = state.room;
  if (previous?.code !== s.code) {
    ['proposalFeedback', 'actionFeedback', 'deskFeedback', 'iconFeedback', 'recoveryFeedback', 'homeFeedback', 'accountFeedback'].forEach((id) => text(id, ''));
    Object.assign(state, { selected: null, cell: null, focus: null, zoom: null, icon: null, boardKey: '', centerPending: true });
    $('privateRecovery').value = ''; $('recoveryOutput').hidden = true; $('iconPreviewBox').hidden = true;
  }
  state.room = s; state.stale = false; $('staleBanner').hidden = true; setConnection('Live', true);
  $('roomBadge').hidden = false; text('roomBadge', s.invite || s.code); $('roomBadge').setAttribute('aria-label', 'Invitation code ' + (s.invite || s.code) + '. Copy.');
  text('phaseLabel', s.phase === 'scheduled' ? 'Awaiting midnight' : s.phase === 'active' ? (s.closed ? `Day ${s.day} · actions closed` : `Day ${s.day} · actions open`) : s.phase === 'ended' ? 'Game over' : 'Lobby');
  text('clockLabel', clockText(s)); $('testBanner').hidden = !s.isTest;
  const self = me(), living = s.players.filter((p) => p.alive);

  $('winnerBanner').hidden = s.phase !== 'ended';
  const ids = s.winners?.length ? s.winners : s.winner !== null && s.winner !== undefined ? [s.winner] : [];
  text('winnerNames', s.players.filter((p) => ids.includes(p.id)).map((p) => p.name).join(', ') || 'Game complete');
  text('winnerCaption', (ids.length > 1 ? 'The remaining survivors share this victory.' : 'One player remains.') + (s.chatExpiresAt ? ` Chat for this game is deleted ${new Date(s.chatExpiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : ''));

  // Resources: a compact labelled row of MY values only (the referee sees room totals instead).
  const shieldText = self?.shield ? (self.shieldDays > 1 ? `Active · ${self.shieldDays} resets` : 'Active') : 'None';
  const stats = s.isHost ? [['players', 'Living', living.length], ['players', 'Players', s.players.length], ['dispatch', 'Day', s.day]]
    : self ? [['point', 'Points', self.points], ['heart', 'Hearts', self.hearts], ['range', 'Range', config().maxRange > 0 ? Math.min(self.range, config().maxRange) : self.range], ['shield', 'Shield', self.alive ? shieldText : '—']] : [];
  $('resources').replaceChildren(...stats.map(([ico, label, value]) => { const n = node('div', undefined, 'resource'); n.append(icon(ico), node('span', label, 'resource-label'), node('b', String(value))); return n; }));
  if (!s.isHost && self && !self.alive) $('resources').append(node('div', 'Eliminated · you keep chat and your vote', 'resource note'));

  $('lobby').hidden = s.phase !== 'lobby'; $('battle').hidden = s.phase === 'lobby';
  if (s.phase === 'lobby') {
    text('lobbyCode', s.invite || s.code);
    text('lobbyCount', `${s.players.length} of 20 seats · 5 needed to start`);
    $('lobbyPeople').replaceChildren(...s.players.map((p) => { const n = node('div', undefined, 'person'); n.append(avatar(p.id, true), node('span', p.name + (p.id === s.me ? ' (you)' : ''))); return n; }));
    text('lobbyNext', s.isHost ? 'Share the code. When everyone is seated, schedule the opening from the host desk.' : 'Waiting for the host to schedule the game. You can set a room name or your own token image in Settings until then.');
    text('lobbyAction', s.isHost ? 'Open the host desk' : 'Open Settings');
  }
  const news = s.events?.[0];
  $('latestDispatch').hidden = !news; if (news) { $('latestDispatch').replaceChildren(node('span', 'Latest dispatch', 'eyebrow'), node('span', news)); }
  $('dispatchList').replaceChildren(...(s.events?.length ? s.events.map((e) => node('li', e)) : [node('li', 'Nothing public has happened yet.', 'hint')]));

  chat?.onRoom(s); renderPlayers(); renderCouncil(); renderSettings(); renderDesk();
  if (state.selected !== null && !s.players.some((p) => p.id === state.selected && p.alive)) state.selected = null;
  if (state.selected === null && !state.cell && self?.alive) state.selected = self.id;
  go(state.view); renderBoard(); renderInspector(); updateControls();
}

function reasonFor(cost = 0, allow = null) {
  const s = state.room, self = me(), cfg = config();
  if (!s) return 'Join a room first.';
  if (state.stale) return 'Waiting for a fresh answer from the server.';
  if (locked()) return state.pending ? 'An earlier request is still unconfirmed.' : 'Waiting for the server.';
  if (s.isHost) return 'The referee does not take player actions.';
  if (s.phase === 'ended') return 'This game is complete.';
  if (s.phase === 'scheduled') return 'The field opens at midnight Pacific.';
  if (s.phase !== 'active') return 'The game has not started.';
  if (!self?.alive) return 'You are eliminated.';
  if (s.closed) return 'Actions are closed until midnight.';
  if (allow && cfg[allow] === false) return 'Disabled by a rule amendment.';
  if (self.points < cost) return `Needs ${pts(cost)}; you have ${self.points}.`;
  return '';
}

// ---------- board ----------
function cellSize() { // fit the whole board when it can stay finger-sized; otherwise it pans inside its viewport
  const width = $('boardViewport').clientWidth || 340, room = Math.min(width - 38, innerHeight * 0.72 - 40);
  return state.zoom || Math.max(36, Math.min(72, Math.floor(room / state.room.size) - 2));
}
function renderBoard() {
  const s = state.room; if (!s || s.phase === 'lobby' || state.view !== 'field') return;
  const self = me(), living = s.players.filter((p) => p.alive), size = s.size, cfg = config(), px = cellSize();
  const reach = self?.alive ? (cfg.maxRange > 0 ? Math.min(self.range, cfg.maxRange) : self.range) : -1;
  const canMove = s.phase === 'active' && !s.closed && self?.alive && cfg.allowMove !== false;
  if (!state.focus) state.focus = self?.alive ? { x: self.x, y: self.y } : { x: 0, y: size - 1 };
  // Polling re-renders only when something visible changed, so scroll position and focus are stable.
  const key = JSON.stringify([s.code, size, px, living.map((p) => [p.id, p.x, p.y, !!p.icon, !!p.shield]), state.selected, state.cell, state.focus, reach, canMove, self?.id]);
  if (key !== state.boardKey) {
    state.boardKey = key;
    const b = $('board'), hadFocus = b.contains(document.activeElement) && document.activeElement.classList.contains('cell'), parts = [];
    b.style.setProperty('--size', size); b.style.setProperty('--cell', px + 'px');
    for (let y = 0; y < size; y++) {
      parts.push(node('span', rankLabel(y, size), 'rank'));
      for (let x = 0; x < size; x++) {
        const p = living.find((q) => q.x === x && q.y === y), cell = node('button', undefined, 'cell ' + ((x + y) % 2 ? 'dark' : 'light')), name = square(x, y, size);
        const dist = self?.alive ? Math.abs(self.x - x) + Math.abs(self.y - y) : 99, inRange = dist > 0 && dist <= reach, movable = canMove && !p && dist === 1;
        const chosen = p ? state.selected === p.id : state.cell?.x === x && state.cell?.y === y, own = !!p && p.id === self?.id;
        cell.type = 'button'; cell.dataset.x = x; cell.dataset.y = y; cell.tabIndex = state.focus.x === x && state.focus.y === y ? 0 : -1;
        if (inRange) cell.classList.add('in-range'); if (movable) cell.classList.add('movable'); if (chosen) cell.classList.add('chosen'); if (own) cell.classList.add('self');
        cell.setAttribute('aria-pressed', String(chosen));
        cell.setAttribute('aria-label', `${name}, ${p ? p.name + (own ? ' (you)' : '') : 'empty'}${inRange ? ', within your range' : ''}${movable ? ', you can move here' : ''}`);
        if (p) { const token = avatar(p.id); token.classList.add('token'); cell.append(token); if (own) cell.append(node('span', 'you', 'you-tag')); if (p.shield) { const badge = node('span', undefined, 'shield-badge'); badge.append(icon('shield')); cell.append(badge); } }
        parts.push(cell);
      }
    }
    parts.push(node('span', '', 'corner'));
    for (let x = 0; x < size; x++) parts.push(node('span', fileLabel(x), 'file'));
    b.replaceChildren(...parts);
    if (hadFocus) b.querySelector(`[data-x="${state.focus.x}"][data-y="${state.focus.y}"]`)?.focus({ preventScroll: true });
  }
  if (state.centerPending && self?.alive && Number.isInteger(self.x)) { centerOn(self.x, self.y); state.centerPending = false; }
  const sel = state.selected !== null ? s.players.find((p) => p.id === state.selected) : null;
  text('selectedSquare', sel?.alive ? where(sel) : state.cell ? square(state.cell.x, state.cell.y, size) : '');
}
function centerOn(x, y) { const view = $('boardViewport'), step = cellSize() + 2; view.scrollLeft = Math.max(0, (x + 1) * step - view.clientWidth / 2); view.scrollTop = Math.max(0, (y + 0.5) * step - view.clientHeight / 2); }
$('board').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell'); if (!cell) return;
  const x = Number(cell.dataset.x), y = Number(cell.dataset.y), p = state.room.players.find((q) => q.alive && q.x === x && q.y === y);
  state.selected = p?.id ?? null; state.cell = p ? null : { x, y }; state.focus = { x, y }; renderBoard(); renderInspector();
});
$('board').addEventListener('keydown', (e) => {
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d || !e.target.classList.contains('cell')) return;
  e.preventDefault(); const size = state.room.size, x = Math.max(0, Math.min(size - 1, Number(e.target.dataset.x) + d[0])), y = Math.max(0, Math.min(size - 1, Number(e.target.dataset.y) + d[1]));
  state.focus = { x, y }; renderBoard(); $('board').querySelector(`[data-x="${x}"][data-y="${y}"]`)?.focus();
});

// ---------- selection and actions ----------
function addAction(ico, label, cost, reason, run, risk = false) {
  const wrap = node('div', undefined, 'action'), button = node('button', undefined, risk ? 'danger-outline' : '');
  button.type = 'button'; button.append(icon(ico), node('span', label), node('span', cost, 'cost')); button.disabled = !!reason; button.onclick = run;
  wrap.append(button); if (reason) wrap.append(node('p', reason, 'hint')); $('actionList').append(wrap);
}
async function act(options, action, extra) { const { confirmed } = await confirmDialog(options); if (confirmed) command(action, extra); }
function renderInspector() {
  const s = state.room; if (!s || s.phase === 'lobby') return;
  const self = me(), cfg = config(), target = s.players.find((p) => p.id === state.selected && p.alive);
  $('actionList').replaceChildren(); $('selectionDetails').replaceChildren(); text('selectionBody', '');
  $('messageSelected').hidden = !target || target.id === self?.id || !!target.isTestSeat;
  $('messageSelected').onclick = () => { if (target) { chat.open(target.id); go('chat'); } };
  if (s.phase === 'ended') { text('selectionLabel', 'Final positions'); text('selectionTitle', 'The game is complete.'); text('selectionBody', 'Read the Official Dispatch for the public record.'); return; }
  if (target) {
    const own = target.id === self?.id;
    text('selectionLabel', own ? 'Your position' : s.isHost ? 'Referee view' : 'Player'); text('selectionTitle', target.name + (own ? ' (you)' : ''));
    text('selectionBody', `${where(target)} · ${crestName(s.code, target.id)}${target.isTestSeat ? ' · test seat' : ''}`);
    if (own || s.isHost) $('selectionDetails').append(node('p', `${plural(target.hearts, 'heart')} · ${pts(target.points)} · range ${target.range}${target.shield ? ' · shielded' : ''}`));
    else $('selectionDetails').append(node('p', 'Their hearts, points, range and shield are private.', 'hint'));
    if (s.isHost) return;
    if (!self?.alive) {
      if (self) addAction('vote', 'Vote for ' + target.name, 'free', s.phase !== 'active' ? 'Voting opens with the game.' : locked() || state.stale ? 'Waiting for the server.' : '',
        () => act({ title: `Vote for ${target.name}?`, body: `If a strict majority of the ballots cast name the same living player, they receive ${pts(cfg.voteBonus)} at midnight. You can change your vote until then.`, cost: 'Free. Your ballot is private.', label: 'Cast vote' }, 'vote', { p_target: target.id }));
      return;
    }
    if (own) {
      addAction('shield', 'Raise shield', pts(cfg.costShield), reasonFor(cfg.costShield, 'allowShield') || (self.shield ? 'Your shield is already active.' : ''),
        () => act({ title: 'Raise your shield?', body: `Attacks on you are rejected until ${cfg.shieldDays > 1 ? `${cfg.shieldDays} midnight resets have passed` : 'the next midnight reset'}. It adds no hearts.`, cost: `Spend ${pts(cfg.costShield)}. Other players cannot see your shield.`, label: 'Raise shield' }, 'shield'));
      addAction('range', 'Extend range', pts(cfg.costRange), reasonFor(cfg.costRange, 'allowRange') || (cfg.maxRange > 0 && self.range >= cfg.maxRange ? `Range is capped at ${cfg.maxRange}.` : ''),
        () => act({ title: 'Extend your range?', body: `Your targeting range goes from ${self.range} to ${self.range + 1} for the rest of this game.`, cost: `Spend ${pts(cfg.costRange)}.`, label: 'Extend range' }, 'range'));
    } else {
      const distance = Math.abs(target.x - self.x) + Math.abs(target.y - self.y), reach = cfg.maxRange > 0 ? Math.min(self.range, cfg.maxRange) : self.range;
      const far = distance > reach ? `${distance} squares away; your range is ${reach}.` : '';
      $('selectionDetails').append(node('p', `${distance} ${distance === 1 ? 'square' : 'squares'} away · your range ${reach}`));
      addAction('attack', 'Attack', pts(cfg.costAttack), reasonFor(cfg.costAttack, 'allowAttack') || far,
        () => act({ title: `Attack ${target.name} at ${where(target)}?`, body: 'A hit removes one heart. You will not see how many they have left. A final blow is announced publicly with your name.', cost: `Spend ${pts(cfg.costAttack)} if the hit lands. A shielded target rejects the attack and you keep your points.`, label: 'Attack', danger: true }, 'attack', { p_target: target.id }), true);
      addAction('give', 'Give 1 point', '1 point', reasonFor(1, 'allowGive') || far,
        () => act({ title: `Give ${target.name} one point?`, body: 'One of your points becomes theirs. Other players do not see it; the referee does.', cost: 'Transfers exactly 1 point. No fee.', label: 'Give point' }, 'give', { p_target: target.id }));
    }
  } else if (state.cell) {
    const { x, y } = state.cell, name = square(x, y, s.size);
    text('selectionLabel', 'Empty square'); text('selectionTitle', name);
    if (self?.alive) {
      const dx = x - self.x, dy = y - self.y, adjacent = Math.abs(dx) + Math.abs(dy) === 1;
      addAction('move', 'Move here', pts(cfg.costMove), reasonFor(cfg.costMove, 'allowMove') || (!adjacent ? 'You can only step to a square directly beside you.' : cfg.moveLimit > 0 && (self.movesToday || 0) >= cfg.moveLimit ? `Daily limit of ${plural(cfg.moveLimit, 'move')} reached.` : ''),
        () => act({ title: `Move from ${where(self)} to ${name}?`, body: 'One orthogonal step. Your move is announced publicly in Dispatch.', cost: `Spend ${pts(cfg.costMove)}.`, label: 'Move' }, 'move', { p_direction: dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up' }));
    }
  } else {
    text('selectionLabel', self?.alive ? 'Your move' : s.isHost ? 'Referee view' : 'Your vote'); text('selectionTitle', 'Select a square.');
    text('selectionBody', self?.alive ? 'Pick a player to attack or give to, your own token to shield or extend range, or a neighbouring empty square to move.' : s.isHost ? 'Pick any token to see its private resources.' : 'Pick a living player to cast or change your private vote.');
  }
}

// ---------- players, rules, proposals ----------
function renderPlayers() {
  const s = state.room;
  text('playersPrivacy', s.isHost ? 'Referee view: private resources are shown to you only.' : 'Positions are public. Everyone else’s resources are private.');
  $('playerList').replaceChildren(...s.players.map((p) => {
    const card = node('article', undefined, 'player' + (p.alive ? '' : ' out')), info = node('div', undefined, 'player-info'), buttons = node('div', undefined, 'button-row');
    info.append(node('h2', p.name + (p.id === s.me ? ' (you)' : '')), node('p', [crestName(s.code, p.id), p.alive ? (s.phase === 'lobby' ? 'seated' : where(p)) : 'eliminated', p.isTestSeat ? 'test seat' : ''].filter(Boolean).join(' · '), 'hint'));
    if (p.hearts !== undefined) info.append(node('p', `${plural(p.hearts, 'heart')} · ${pts(p.points)} · range ${p.range}${p.shield ? ' · shielded' : ''}`));
    if (p.alive && s.phase !== 'lobby') { const b = node('button', 'Show on field'); b.onclick = () => { state.selected = p.id; state.cell = null; state.focus = { x: p.x, y: p.y }; go('field'); renderBoard(); renderInspector(); centerOn(p.x, p.y); }; buttons.append(b); }
    if (!p.isTestSeat && p.id !== s.me) { const b = node('button', 'Message'); b.onclick = () => { chat.open(p.id); go('chat'); }; buttons.append(b); }
    card.append(avatar(p.id, true), info, buttons); return card;
  }));
}
function rulesRows(s) {
  const c = config(s), off = (k) => (c[k] === false ? ' — currently disabled' : '');
  return [
    ['Move', `${pts(c.costMove)} · one orthogonal square, never diagonal or onto an occupied square${c.moveLimit > 0 ? ` · at most ${plural(c.moveLimit, 'move')} a day` : ''}${off('allowMove')}`],
    ['Attack', `${pts(c.costAttack)} on a hit · removes one heart · a shielded target rejects it for free${off('allowAttack')}`],
    ['Give', `exactly 1 point to a living player in range · no fee${off('allowGive')}`],
    ['Range', `starts at ${c.baseRange} (Manhattan distance)${c.maxRange > 0 ? ` · capped at ${c.maxRange}` : ''} · upgrade +1 for ${pts(c.costRange)}${off('allowRange')}`],
    ['Shield', `${pts(c.costShield)} · lasts until ${c.shieldDays > 1 ? `${c.shieldDays} midnight resets pass` : 'the next midnight'} · adds no hearts${off('allowShield')}`],
    ['Income', `${pts(c.dailyIncome)} for each living player at every Pacific midnight · unspent points accumulate`],
    ['Action window', s.isTest ? 'Test room: the host opens and closes days by hand' : c.cutoffHour === 24 ? 'All day, Pacific time' : `Midnight to ${hourText(c.cutoffHour)} Pacific`],
    ['Elimination', c.forfeitOnElimination === false ? 'Zero hearts eliminates. Older room: the recorded balance stays but cannot be spent.' : 'Zero hearts eliminates and forfeits all remaining points. Withdrawal is free and permanent.'],
    ['Eliminated vote', `strict majority of ballots cast gives a living player ${pts(c.voteBonus)} at midnight`],
    ['Victory', `last ${plural(s.survivorGoal || 1, 'survivor')} ${(s.survivorGoal || 1) === 1 ? 'wins' : 'share victory'}`],
    ['Rule proposal', `${pts(c.costProposal)}, charged only when the host approves`],
  ];
}
function renderCouncil() {
  const s = state.room, self = me();
  text('rulesVersionLine', `Rules version ${s.rulesVersion || 'legacy-v0.5'}${s.rulesVersion === CURRENT_RULES ? '' : ' · an earlier version, kept as this room started'}${s.isTest ? ' · test room' : ''}`);
  $('rulesSummary').replaceChildren(...rulesRows(s).flatMap(([k, v]) => [node('dt', k), node('dd', v)]));
  const amendments = s.amendments || [], titles = new Set(amendments.filter((a) => a.origin === 'proposal').map((a) => a.title));
  const older = (s.rules || []).filter((q) => !titles.has(q.title));
  const items = amendments.map((a) => {
    const card = node('article', undefined, 'rule'), tags = node('p', undefined, 'tags');
    tags.append(node('span', a.origin === 'host' ? 'Host amendment' : 'Player proposal' + (a.proposerName ? ' · ' + a.proposerName : ''), 'tag'));
    if (a.status === 'scheduled') tags.append(node('span', 'Part scheduled for the next reset', 'tag tag-warn'));
    if (a.status === 'cancelled') tags.append(node('span', 'Scheduled part cancelled', 'tag tag-warn'));
    if (a.corrects) tags.append(node('span', 'Correction', 'tag'));
    const list = node('ul'); (a.lines || []).forEach((l) => { const li = node('li', l.text); if (l.hostEnforced) li.prepend(node('span', 'Host-enforced', 'tag tag-warn'), ' '); if (l.when === 'next_reset') li.prepend(node('span', 'Next reset', 'tag'), ' '); list.append(li); });
    card.append(tags, node('h3', a.title), list, node('p', 'Reason: ' + a.reason, 'hint'), node('p', new Date(a.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 'hint'));
    if (s.isHost && s.phase !== 'ended') {
      const row = node('div', undefined, 'button-row'), fix = node('button', 'Draft a correction'); fix.onclick = () => { go('desk'); desk.draftCorrection(a); }; row.append(fix);
      if (a.status === 'scheduled') { const cancel = node('button', 'Cancel scheduled part'); cancel.disabled = locked(); cancel.onclick = async () => {
        const r = await confirmDialog({ title: `Cancel the scheduled part of “${a.title}”?`, body: 'Only what has not happened yet is cancelled. Anything already applied stays applied.', cost: 'Your reason is published in Dispatch.', label: 'Cancel scheduled part', input: { label: 'Public reason · required', max: 500 } });
        if (r.confirmed) { if (!r.input) notice('A public reason is required.', 'deskFeedback'); else send('tt_amend_cancel', { p_code: s.code, p_request: crypto.randomUUID(), p_amendment: a.id, p_reason: r.input }); } }; row.append(cancel); }
      card.append(row);
    }
    return card;
  });
  older.forEach((q) => { const card = node('article', undefined, 'rule'); card.append(node('p', q.kind === 'house_rule' ? 'Host-enforced · earlier approval' : 'Earlier approval', 'tags'), node('h3', q.title), node('p', q.body)); if (q.authorName) card.append(node('p', 'Proposed by ' + q.authorName, 'hint')); items.push(card); });
  $('ruleHistory').replaceChildren(...(items.length ? items : [node('p', 'No changes yet. The starting rules stand.', 'hint')]));

  $('proposalCard').hidden = s.isHost; $('proposalForm').hidden = !self?.alive; text('proposalPrice', config().costProposal);
  text('proposalHeading', self?.alive ? 'Propose a change' : 'Your proposals');
  const mine = s.isHost ? [] : s.proposals || [];
  $('proposalList').replaceChildren(...mine.map((q) => { const card = node('article', undefined, 'rule'); card.append(node('p', q.status === 'pending' ? 'Waiting for the host' : q.status === 'approved' ? 'Approved' : 'Rejected · no charge', 'tags'), node('h3', q.title), node('p', q.body)); if (q.reason) card.append(node('p', 'Host note: ' + q.reason, 'hint')); return card; }));
}
function proposalReason() { const s = state.room; return reasonFor(config().costProposal) || ((s.proposals || []).some((q) => q.status === 'pending') ? 'You already have a pending proposal.' : ''); }
function updateProposalForm() { $('survivorField').hidden = $('proposalKind').value !== 'last_survivors'; }

// ---------- settings ----------
function renderSettings() {
  const s = state.room, self = me(), a = state.account;
  const ready = a?.status === 'ready', guest = a?.status === 'guest';
  text('accountStatus', ready ? `Signed in as ${a.profile.displayName} (@${a.profile.username}).` : guest ? 'Guest identity from an earlier version. Create an account on the Home screen to keep these seats and to host or join new games.' : a?.user ? 'Signed in. Finish your profile on the Home screen.' : 'Not signed in.');
  text('menuAccount', ready ? '@' + a.profile.username : guest ? 'Guest identity' : '');
  $('displayForm').hidden = !ready; if (ready && document.activeElement !== $('displayName')) $('displayName').value = a.profile.displayName;
  $('roomNameForm').hidden = !(s && self && s.phase === 'lobby'); if (self && document.activeElement !== $('roomName')) $('roomName').value = self.name;
  $('leaveRoom').hidden = !s; $('signOut').hidden = !a?.user;
  $('iconCard').hidden = !s || s.isHost || !self; $('recoveryCard').hidden = !s; $('withdrawCard').hidden = !(s && self?.alive && s.phase === 'active');
  text('appVersion', 'Version ' + APP_VERSION + '.');
  if (!s) return;
  if (self) {
    $('tokenPreview').replaceChildren(avatar(self.id, true), node('span', self.icon ? 'Your image' : `Your crest: ${crestName(s.code, self.id)}`));
    const canChoose = s.phase === 'lobby' && !self.icon; $('iconPicker').hidden = !canChoose;
    text('iconStatus', self.icon ? 'Your image is locked for this game and visible to everyone.' : s.phase !== 'lobby' ? 'Every player gets a crest that is unique in the room. Custom images can only be chosen before the game is scheduled.' : 'Every player gets a crest that is unique in the room. You may replace yours with an image; confirming locks it for this game.');
    if (self.icon) { state.icon = null; $('iconPreviewBox').hidden = true; }
  }
  text('recoveryRole', s.isHost ? 'the host role' : 'your seat');
}

// ---------- host desk ----------
function renderDesk() {
  const s = state.room; if (!s.isHost) return;
  const n = s.players.length, legacy = s.requiredBoardSize === null && s.rulesVersion === 'legacy-v0.5';
  $('startControls').hidden = s.phase !== 'lobby'; $('manualControls').hidden = !s.isTest || s.phase !== 'active';
  text('deskStatus', `${s.phase === 'lobby' ? `${plural(n, 'player')} seated.` : s.phase === 'ended' ? 'Game over.' : `Day ${s.day}.`} ${clockText(s)}`);
  text('start', s.isTest ? 'Start test game now' : 'Schedule opening at the next Pacific midnight');
  $('legacySize').hidden = !legacy;
  if (legacy && state.deskKey !== s.code + ':' + n) { $('boardSize').value = Math.max(3, n - 1); state.deskKey = s.code + ':' + n; }
  text('startReason', n < 5 ? `${plural(5 - n, 'more player')} needed.` : legacy ? 'Older room: choose a board side length.' : s.requiredBoardSize ? `Board: ${s.requiredBoardSize} × ${s.requiredBoardSize} for ${plural(n, 'player')}, fixed by the rules.` : `This room’s rules version does not define a board for ${plural(n, 'player')}. Add a player, or move the room to the current rules below.`);
  $('migrateWrap').hidden = s.rulesVersion === CURRENT_RULES || s.phase === 'ended' || !s.config;
  text('migrateText', s.phase === 'lobby' ? `This lobby uses ${s.rulesVersion}. Migrating gives every seat the current starting values (range 4) and the current board table, including 8 × 8 for six players.` : `This game uses ${s.rulesVersion}. Migrating changes costs, cutoff and elimination rules to the current version from now on. No player’s current range, hearts or points change, and nothing is replayed.`);
  $('deleteWrap').hidden = s.phase !== 'ended';
  const pending = (s.proposals || []).filter((q) => q.status === 'pending'), open = s.phase === 'active' && !s.closed;
  $('reviewList').replaceChildren(...(pending.length ? pending.map((q) => {
    const card = node('article', undefined, 'rule'), row = node('div', undefined, 'button-row'), compose = node('button', 'Compose effects…', 'primary'), quick = node('button', 'Approve as proposed'), reject = node('button', 'Reject');
    const kind = q.kind === 'all_hearts' ? 'Asks for: every living player gains one heart.' : q.kind === 'last_survivors' ? `Asks for: last ${q.survivorCount} survivors share victory.` : 'A written request. Compose engine effects for it, or approve it as a host-enforced written rule.';
    card.append(node('p', 'From ' + q.authorName, 'tags'), node('h3', q.title), node('p', q.body), node('p', kind, 'hint'));
    compose.disabled = quick.disabled = locked() || state.stale || !open; reject.disabled = locked() || state.stale;
    compose.onclick = () => desk.reviewProposal(q);
    quick.onclick = async () => { const r = await confirmDialog({ title: `Approve “${q.title}” as proposed?`, body: kind, cost: `${q.authorName} pays ${pts(config().costProposal)}; their balance is rechecked. The change and its proposer become public.`, label: 'Approve', input: { label: 'Public note · optional', max: 300 } });
      if (r.confirmed) send('tt_review', { p_code: s.code, p_request: crypto.randomUUID(), p_proposal: q.id, p_decision: 'approve', p_reason: r.input.slice(0, 300) }); };
    reject.onclick = async () => { const r = await confirmDialog({ title: 'Reject this proposal?', body: 'Only the author and you will see the rejection and your note.', cost: 'No points are charged.', label: 'Reject', input: { label: 'Note to the author · optional', max: 300 } });
      if (r.confirmed) send('tt_review', { p_code: s.code, p_request: crypto.randomUUID(), p_proposal: q.id, p_decision: 'reject', p_reason: r.input.slice(0, 300) }); };
    row.append(compose, quick, reject); card.append(row); if (!open) card.append(node('p', 'Approval needs an open action window. Rejecting is always possible.', 'hint'));
    return card;
  }) : [node('p', 'Nothing waiting.', 'hint')]));
  $('hostLog').replaceChildren(...(s.hostLog || []).slice(0, 150).map((t) => node('li', t)));
  if (state.view === 'desk') desk.render();
}

function updateControls() {
  const busy = locked(), s = state.room;
  $('retry').disabled = state.busy; $('retry').hidden = !state.pending; $('dismissStatus').hidden = !!state.pending;
  document.querySelectorAll('#joinForm button, #recoverForm button, #createRoom').forEach((b) => { b.disabled = busy; });
  $('saveIcon').disabled = busy || state.iconReading || !state.icon; $('iconFile').disabled = busy || state.iconReading;
  if (!s) return;
  $('staleBanner').hidden = !state.stale;
  if (!s.isHost) { const why = proposalReason(); $('submitProposal').disabled = !!why; text('proposalReason', why); }
  $('start').disabled = busy || state.stale || s.players.length < 5 || !s.isHost || s.phase !== 'lobby' || (s.config && s.requiredBoardSize === null && s.rulesVersion !== 'legacy-v0.5');
  $('fillTest').disabled = busy || state.stale || s.phase !== 'lobby' || s.players.length < 1 || s.players.length >= 5;
  $('closeDay').disabled = busy || state.stale || s.closed; $('nextDay').disabled = busy || state.stale;
  $('withdraw').disabled = !!reasonFor(0); text('withdrawReason', reasonFor(0));
  $('makeRecovery').disabled = busy; $('migrate').disabled = busy; $('deleteRoom').disabled = busy;
  renderInspector(); if (state.view === 'desk' && s.isHost) desk.render();
}

// ---------- home ----------
function renderHome() {
  let list = []; try { list = JSON.parse(store.get('tt-rooms') || '[]'); } catch { /* none */ }
  const last = store.get('tt-online-room'); if (last && !list.some((r) => r.code === last)) list.unshift({ code: last, invite: null, role: 'Saved' });
  const buttons = () => list.map((r) => { const b = node('button', `${r.invite || r.code} · ${r.role}`); b.onclick = () => openRoom(r.code); return b; });
  $('recentRooms').hidden = !list.length; $('recentList').replaceChildren(...buttons()); $('guestRooms').replaceChildren(...buttons());
}

// ---------- wiring ----------
$('retry').onclick = () => { if (state.pending && !state.busy) send(state.pending.name, state.pending.args); };
$('dismissStatus').onclick = () => { $('requestStatus').hidden = true; };
$('refresh').onclick = refresh;
$('joinForm').onsubmit = (e) => { e.preventDefault(); if (!locked()) send('tt_join', { p_code: $('joinCode').value.trim(), p_name: $('joinName').value.trim() || null }); };
$('createRoom').onclick = () => { if (!locked()) send('tt_create', {}); };
$('recoverForm').onsubmit = async (e) => {
  e.preventDefault(); if (locked()) return;
  const token = $('recoverToken').value.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(token)) { text('homeFeedback', 'Enter the complete 64-character recovery code.'); return; }
  const { confirmed } = await confirmDialog({ title: 'Restore this role to your account?', body: 'The previous identity loses control of it. Nothing about the seat, its resources or its messages changes.', cost: 'Your account must not already hold another role in that room.', label: 'Restore role' });
  if (confirmed) send('tt_recover', { p_code: $('recoverRoom').value.trim(), p_token: token });
};
async function copyInvite(link) {
  const s = state.room; if (!s) return; const code = s.invite || s.code, value = link ? `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}` : code;
  notice(await copyText(value) ? (link ? 'Invite link copied.' : 'Invitation code copied.') : `Copy this by hand: ${value}`);
}
$('roomBadge').onclick = $('copyInvite').onclick = () => copyInvite(false); $('copyLink').onclick = () => copyInvite(true);
$('lobbyAction').onclick = () => go(state.room?.isHost ? 'desk' : 'settings'); $('latestDispatch').onclick = () => go('dispatch');
$('zoomIn').onclick = () => { state.zoom = Math.min(96, cellSize() + 8); renderBoard(); }; $('zoomOut').onclick = () => { state.zoom = Math.max(32, cellSize() - 8); renderBoard(); };
$('findMe').onclick = () => { const self = me(); if (self?.alive) { state.selected = self.id; state.cell = null; state.focus = { x: self.x, y: self.y }; renderBoard(); renderInspector(); centerOn(self.x, self.y); } else notice(state.room?.isHost ? 'The referee has no token. Select any token to inspect it.' : 'You are no longer on the field.'); };
$('proposalKind').onchange = updateProposalForm;
$('proposalForm').onsubmit = (e) => {
  e.preventDefault(); if (proposalReason()) return;
  const args = { p_code: state.room.code, p_request: crypto.randomUUID(), p_title: $('proposalTitle').value.trim(), p_body: $('proposalBody').value.trim() };
  if ($('proposalKind').value === 'last_survivors') send('tt_propose_survivors', { ...args, p_count: Number($('survivorCount').value) }); else send('tt_propose', { ...args, p_kind: $('proposalKind').value });
};
$('start').onclick = async () => { const s = state.room, legacy = !$('legacySize').hidden;
  const { confirmed } = await confirmDialog({ title: s.isTest ? 'Start this test game?' : 'Schedule the opening?', body: s.isTest ? 'Test play starts immediately. Placeholder seats never act or vote.' : 'The field opens at the next Pacific midnight. Joining, room names and token images lock now. No one has a spendable point until then.', cost: `${plural(s.players.length, 'player')}${s.requiredBoardSize ? ` · ${s.requiredBoardSize} × ${s.requiredBoardSize} board` : ''}.`, label: s.isTest ? 'Start test' : 'Schedule game' });
  if (confirmed) command('start', legacy ? { p_size: Number($('boardSize').value) } : {}); };
$('fillTest').onclick = async () => { const { confirmed } = await confirmDialog({ title: 'Turn this into a test room?', body: 'Adds stationary placeholders up to five seats. The room is labelled a test permanently and uses manual day controls.', cost: 'Not a real competitive match.', label: 'Add test seats' }); if (confirmed) send('tt_fill_test_seats', { p_code: state.room.code }); };
$('closeDay').onclick = async () => { const { confirmed } = await confirmDialog({ title: 'Close actions for this test day?', body: 'Votes can still be cast.', label: 'Close actions' }); if (confirmed) command('close'); };
$('nextDay').onclick = async () => { const { confirmed } = await confirmDialog({ title: 'Advance the test day?', body: 'Settles votes, ends expired shields, applies scheduled amendments and awards income — exactly as a midnight reset would.', label: 'Advance day' }); if (confirmed) command('next_day'); };
$('withdraw').onclick = async () => { const { confirmed } = await confirmDialog({ title: 'Withdraw from this game?', body: 'You are eliminated permanently and lose your remaining points. There is no undo or revival. You keep chat and your vote.', cost: 'Free. This is not signing out.', label: 'Withdraw permanently', danger: true }); if (confirmed) command('remove'); };
$('migrate').onclick = async () => { const r = await confirmDialog({ title: 'Migrate this room’s rules version?', body: $('migrateText').textContent, cost: 'Announced publicly in Dispatch. This cannot be reversed.', label: 'Migrate', danger: true, input: { label: 'Type MIGRATE to confirm', max: 10 } });
  if (r.confirmed) send('tt_migrate_rules', { p_code: state.room.code, p_request: crypto.randomUUID(), p_version: CURRENT_RULES, p_confirm: r.input }); };
$('deleteRoom').onclick = async () => { const r = await confirmDialog({ title: 'Delete this finished room for everyone?', body: 'The room, its chat, proposals, rule history and recovery codes are permanently removed. Accounts are untouched. Copies people already saved elsewhere cannot be erased.', cost: 'This cannot be undone.', label: 'Delete room', danger: true, input: { label: 'Type DELETE to confirm', max: 10 } });
  if (r.confirmed) send('tt_delete_room', { p_code: state.room.code, p_confirm: r.input }); };
$('leaveRoom').onclick = () => { if (!locked()) leaveRoom('You left the room view. Your seat is kept; reopen it from “Your rooms”.'); };
$('signOut').onclick = async () => {
  const guest = state.account?.status === 'guest';
  const { confirmed } = await confirmDialog({ title: 'Sign out on this device?', body: guest ? 'This is a guest identity. Signing out abandons it: its seats can then only be restored with their recovery codes.' : 'Your seats stay with your account. Notifications for this device are turned off.', label: 'Sign out', danger: guest });
  if (!confirmed) return;
  await notifications.disableDevice(); leaveRoom(''); store.set('tt-rooms', null); await accounts.signOut(); text('homeFeedback', 'Signed out.');
};
$('displayForm').onsubmit = async (e) => { e.preventDefault(); try { await accounts.saveDisplayName($('displayName').value.trim()); text('accountFeedback', 'Display name saved. Rooms you already joined keep the name you have there.'); } catch (err) { text('accountFeedback', err.message); } };
$('roomNameForm').onsubmit = (e) => { e.preventDefault(); if (!locked()) send('tt_set_room_name', { p_code: state.room.code, p_name: $('roomName').value.trim() }); };

$('iconFile').onchange = async () => {
  const file = $('iconFile').files[0], version = ++state.iconVersion; state.icon = null; $('iconPreviewBox').hidden = true; text('iconFeedback', '');
  if (!file) { updateControls(); return; }
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { text('iconFeedback', 'Choose a PNG or JPG no larger than 5 MB.'); updateControls(); return; }
  state.iconReading = true; updateControls(); let bitmap;
  try {
    bitmap = await createImageBitmap(file); if (bitmap.width * bitmap.height > 24000000) throw Error('Choose an image smaller than 24 megapixels.');
    // Re-encoded to a 64 × 64 PNG in the browser: the original file and its metadata are never uploaded.
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const ctx = canvas.getContext('2d'); if (!ctx) throw Error('Image conversion is not supported in this browser.');
    const scale = Math.min(64 / bitmap.width, 64 / bitmap.height), w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    ctx.drawImage(bitmap, (64 - w) / 2, (64 - h) / 2, w, h); const data = canvas.toDataURL('image/png');
    if (!safeIcon(data)) throw Error('Try a simpler image.'); if (version !== state.iconVersion) return;
    state.icon = data; $('iconPreview').src = data; $('iconPreviewBox').hidden = false; text('iconFeedback', 'Preview only. Nothing is saved until you confirm.');
  } catch (e) { text('iconFeedback', e.message || 'Could not read this image.'); } finally { bitmap?.close(); state.iconReading = false; updateControls(); }
};
$('saveIcon').onclick = async () => { if (!state.icon) return; const { confirmed } = await confirmDialog({ title: 'Use this image as your token?', body: 'Everyone in the room sees it. Once confirmed it cannot be changed during this game.', cost: 'Replaces your crest for this game.', label: 'Lock my image' }); if (confirmed) send('tt_set_icon', { p_code: state.room.code, p_icon: state.icon }); };
$('makeRecovery').onclick = async () => { const { confirmed } = await confirmDialog({ title: 'Create a private recovery code?', body: 'Anyone holding this code and the room code can take over this role. Creating one invalidates any earlier code for the role.', cost: 'Shown once on this screen. Store it in a password manager.', label: 'Create code' });
  if (confirmed) send('tt_save_recovery', { p_code: state.room.code, p_token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('') }); };
$('copyRecovery').onclick = async () => { if (!$('privateRecovery').value) return; const ok = await copyText(`Turn Tactics — PRIVATE RECOVERY\nRoom: ${state.room.code}\nCode: ${$('privateRecovery').value}`); text('recoveryFeedback', ok ? 'Copied. Paste it somewhere private, then hide it here.' : `Clipboard unavailable. Select the code and copy it by hand, with room code ${state.room.code}.`); if (!ok) { $('privateRecovery').focus(); $('privateRecovery').select(); } };
$('hideRecovery').onclick = () => { $('privateRecovery').value = ''; $('recoveryOutput').hidden = true; text('recoveryFeedback', 'Hidden. If you did not save it, create a replacement.'); };

// Appearance: a small fixed set of choices, remembered on this device.
document.querySelectorAll('.segmented').forEach((group) => {
  const sync = () => group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(window.ttAppearance.get(group.dataset.pref) === b.value)));
  group.querySelectorAll('button').forEach((b) => { b.type = 'button'; b.onclick = () => { window.ttAppearance.set(group.dataset.pref, b.value); sync(); state.boardKey = ''; renderBoard(); }; });
  sync();
});

function applyLink(url) { // from a notification click or a shared invite link; same-origin values only
  const params = new URL(url, location.href).searchParams, room = params.get('room'), view = params.get('view'), join = params.get('join');
  if (join && /^[A-Za-z0-9 -]{6,14}$/.test(join)) $('joinCode').value = join.toUpperCase();
  if (room && /^[A-Za-z0-9]{6,40}$/.test(room) && state.account?.user) { openRoom(room.toUpperCase(), ['field', 'chat', 'council', 'dispatch', 'players'].includes(view) ? view : 'field'); return true; }
  return false;
}
function onAccount(account) {
  const before = state.account?.user?.id; state.account = account;
  if (before && before !== account.user?.id && state.room) leaveRoom('');
  renderHome(); renderSettings(); notifications?.load();
  setConnection(account.user ? 'Connected' : 'Signed out', !!account.user);
}

async function start() {
  hydrateIcons(); updateProposalForm(); renderHome(); go('field'); $('menu').inert = !wide.matches;
  window.addEventListener('online', () => { $('offlineBanner').hidden = true; refresh(); }); window.addEventListener('offline', () => { $('offlineBanner').hidden = false; });
  $('offlineBanner').hidden = navigator.onLine !== false;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => { /* the app works without it; only offline shell and push are lost */ });
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'tt-open' && typeof e.data.url === 'string') applyLink(e.data.url); });
  }
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) { text('homeFeedback', 'Connection settings are missing. Keep your existing online-config.js beside these files.'); return; }
  // A failed email link (expired, or already opened by a mail scanner) comes back as #error=…. It is explained
  // below and removed here first, because the Auth library ends the current session when it finds one.
  const linkFailed = /(^#|&)error(_code|_description)?=/.test(location.hash);
  if (linkFailed) history.replaceState(null, '', location.pathname + location.search);
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.49.1');
    state.db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  } catch { text('homeFeedback', 'Could not load the connection library. Check your connection and reload.'); return; }
  chat = createChat({ getRoom: () => state.room, rpc, avatar: (seat) => avatar(seat) });
  desk = createRulesDesk({ getRoom: () => state.room, rpc, send, isLocked: () => locked() || state.stale });
  notifications = createNotifications({ rpc, isSignedIn: () => !!state.account?.user });
  accounts = createAccount({ db: state.db, rpc, onChange: onAccount, getRememberedRoom: () => store.get('tt-online-room') });
  const account = await accounts.refresh();
  text('homeFeedback', account.status === 'backendPending' ? $('homeFeedback').textContent : linkFailed ? 'That email link has expired or was already used. If your account is already confirmed, just sign in. Otherwise create the account again, or use “Forgot your password?”, to get a new link.' : '');
  if (account.user && !applyLink(location.href)) { const last = store.get('tt-online-room'); if (last) await openRoom(last); }
  else if (!account.user) applyLink(location.href);
  if (location.search) history.replaceState(null, '', location.pathname);
  if (state.pending) notice('An earlier request was never confirmed. Retry that same request before doing anything else.');
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('resize', () => { if (!state.zoom) renderBoard(); });
  setInterval(refresh, 4000);
}
start();
