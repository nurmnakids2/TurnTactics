// Seat-scoped conversations: one room channel plus participant-only direct messages.
// Game state and the Official Dispatch are untouched by anything here. Messages are sent as
// typed; nothing is rewritten or passed to any third party.
import { $, node, icon } from './ui.js?v=1.0.1';

export function createChat({ getRoom, rpc, avatar }) {
  const peerKey = (p) => (p === null ? 'room' : String(p));
  let ctx = null, active = false;
  const drafts = new Map();
  const storageKey = (c) => 'tt-chat-pending:' + c.key;

  function savePending(c, value) {
    c.pending = value;
    try { if (value) sessionStorage.setItem(storageKey(c), JSON.stringify(value)); else sessionStorage.removeItem(storageKey(c)); } catch { /* storage unavailable */ }
  }
  const feedback = (message) => { $('chatFeedback').textContent = message; };
  function errorText(e) {
    if (e?.code === 'PGRST202') return 'Chat is not installed on this server yet.';
    if (/expired/i.test(e?.message || '')) return 'This finished game’s chat has expired and was deleted.';
    return e?.message || 'Connection interrupted. Your message has not been confirmed.';
  }
  function blankContext(room, seat) {
    return { key: room.code + ':' + seat, code: room.code, seat, peer: null,
      threads: [{ peer: null, name: 'Room chat', unread: 0 }, ...(seat !== -1 ? [{ peer: -1, name: 'Host / referee', unread: 0 }] : []),
        ...room.players.filter((p) => !p.isTestSeat && p.id !== seat).map((p) => ({ peer: p.id, name: p.name, unread: 0 }))],
      messages: [], newest: null, oldest: null, seen: null, loaded: false, hasOlder: false, online: false, expired: false,
      fetching: false, inboxBusy: false, inboxAgain: false, acking: false, sending: false, pending: null, replyTo: null };
  }

  function controls() {
    const c = ctx, busy = !!c?.sending, pending = !!c?.pending, closed = !c || c.expired;
    $('chatBody').disabled = closed || busy || pending;
    $('chatSend').disabled = closed || busy || pending || !c.online || !$('chatBody').value.trim();
    $('chatSend').textContent = busy ? 'Sending…' : 'Send';
    $('chatRetry').hidden = !pending; $('chatRetry').disabled = busy;
    $('chatThreadSelect').disabled = busy || pending;
    $('chatOlder').disabled = !!c?.fetching; $('chatOlder').hidden = !c?.hasOlder;
    $('chatCount').textContent = $('chatBody').value.length + ' / 1000';
    $('chatReconnect').hidden = !c || c.online || c.expired;
    $('chatReply').hidden = !c?.replyTo;
    if (c?.replyTo) $('chatReplyText').textContent = `Replying to ${c.replyTo.senderName}: ${c.replyTo.excerpt}`;
  }
  function badge() {
    if (!ctx) return;
    const count = ctx.threads.reduce((n, t) => n + Number(t.unread || 0), 0);
    $('chatBadge').hidden = !count; $('chatBadge').textContent = count > 99 ? '99+' : String(count);
    $('chatNav').setAttribute('aria-label', count ? `Chat, ${count} unread` : 'Chat');
  }
  const threadIcon = (peer) => (peer === null ? Object.assign(node('span', undefined, 'avatar avatar-room'), { ariaHidden: 'true' }) : avatar(peer));

  function renderThreads() {
    const c = ctx; if (!c) return; badge();
    const focused = document.activeElement?.dataset?.chatPeer;
    $('chatThreads').replaceChildren(...c.threads.map((t) => {
      const key = peerKey(t.peer), b = node('button', undefined, 'thread' + (key === peerKey(c.peer) ? ' active' : ''));
      b.type = 'button'; b.dataset.chatPeer = key; b.setAttribute('aria-current', key === peerKey(c.peer) ? 'true' : 'false');
      const first = threadIcon(t.peer); if (t.peer === null) first.append(icon('chat'));
      const label = node('span', undefined, 'thread-text'), title = node('strong', t.name);
      label.append(title, node('small', t.preview || (t.peer === null ? 'Everyone in this room' : 'Direct message')));
      b.append(first, label); if (t.unread) b.append(node('b', t.unread > 99 ? '99+' : String(t.unread), 'count'));
      b.onclick = () => open(t.peer); return b;
    }));
    if (focused) $('chatThreads').querySelector(`[data-chat-peer="${focused}"]`)?.focus({ preventScroll: true });
    const select = $('chatThreadSelect'), signature = JSON.stringify(c.threads.map((t) => [t.peer, t.name, t.unread]));
    if (document.activeElement !== select && select.dataset.signature !== signature) {
      select.replaceChildren(...c.threads.map((t) => { const o = node('option', t.name + (t.unread ? ` · ${t.unread} unread` : '')); o.value = peerKey(t.peer); return o; }));
      select.dataset.signature = signature;
    }
    select.value = peerKey(c.peer);
    const t = c.threads.find((x) => x.peer === c.peer);
    $('chatThreadTitle').textContent = t?.name || 'Direct message';
    $('chatPrivacy').textContent = c.peer === null ? 'Everyone in this room: host, living and eliminated players.' : 'Direct message · only the two of you · not end-to-end encrypted.';
    controls();
  }

  const nearBottom = () => { const n = $('chatMessages'); return n.scrollHeight - n.scrollTop - n.clientHeight < 56; };
  function messageNode(c, m) {
    const own = m.sender === c.seat, li = node('li', undefined, 'message' + (own ? ' own' : '') + (m.sender === -1 ? ' from-host' : ''));
    const bubble = node('div', undefined, 'bubble'), head = node('header'), date = new Date(m.sentAt);
    const time = node('time', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = m.sentAt; time.title = date.toLocaleString();
    head.append(node('strong', own ? 'You' : m.senderName));
    if (m.sender === -1) head.append(node('span', 'Host', 'role-tag'));
    head.append(time); bubble.append(head);
    if (m.reply) { const quote = node('blockquote'); quote.append(node('cite', m.reply.sender === c.seat ? 'You' : m.reply.senderName), node('span', m.reply.excerpt)); bubble.append(quote); }
    bubble.append(node('p', m.body));
    const reply = node('button', undefined, 'reply-button'); reply.type = 'button'; reply.append(icon('reply')); reply.setAttribute('aria-label', 'Reply to ' + (own ? 'your message' : m.senderName));
    reply.onclick = () => { if (ctx !== c || c.pending) return; c.replyTo = { id: m.id, senderName: own ? 'yourself' : m.senderName, excerpt: m.body.slice(0, 140) }; controls(); $('chatBody').focus(); };
    li.append(avatar(m.sender), bubble, reply); return li;
  }
  function renderMessages(older = false, initial = false) {
    const c = ctx; if (!c) return;
    const feed = $('chatMessages'), height = feed.scrollHeight, top = feed.scrollTop, atBottom = nearBottom();
    if (!c.messages.length) feed.replaceChildren(node('li', c.expired ? 'This finished game’s chat has expired and was deleted.' : c.loaded ? 'No messages yet.' : c.online ? 'Loading…' : 'Connecting…', 'chat-empty'));
    else feed.replaceChildren(...c.messages.map((m) => messageNode(c, m)));
    if (older) feed.scrollTop = top + feed.scrollHeight - height; else if (atBottom || initial) feed.scrollTop = feed.scrollHeight;
    $('chatNew').hidden = nearBottom(); controls();
  }
  function fail(c, e) {
    if (c !== ctx) return;
    c.online = false; c.expired = /expired/i.test(e?.message || '');
    $('chatConnection').textContent = c.expired ? 'Expired' : 'Offline';
    if (c.expired) { c.messages = []; c.threads = c.threads.map((t) => ({ ...t, unread: 0, preview: '' })); renderThreads(); renderMessages(); }
    if (active || c.expired) feedback(errorText(e)); controls();
  }

  async function inbox() {
    const c = ctx; if (!c || document.hidden || c.expired) return;
    if (c.inboxBusy) { c.inboxAgain = true; return; }
    c.inboxBusy = true;
    try {
      const data = await rpc('tt_chat_inbox', { p_code: c.code });
      if (c !== ctx) return; // a late answer for a conversation that is no longer open is discarded
      if (data?.me !== c.seat || !Array.isArray(data.threads)) throw Error('Room membership changed. Reopen the room.');
      c.threads = data.threads; c.online = true; renderThreads(); $('chatConnection').textContent = 'Live while open';
    } catch (e) { fail(c, e); }
    finally { c.inboxBusy = false; if (c === ctx && c.inboxAgain) { c.inboxAgain = false; inbox(); } }
  }
  async function acknowledge() {
    const c = ctx; if (!c || !active || document.hidden || !nearBottom() || !c.newest || c.seen === c.newest || c.acking) return;
    c.acking = true; const id = c.newest;
    try { await rpc('tt_chat_ack', { p_code: c.code, p_peer: c.peer, p_last: id }); if (c === ctx) { c.seen = id; inbox(); } }
    catch { /* retried on a later refresh; unseen messages are never marked read locally */ }
    finally { c.acking = false; }
  }
  async function pull(older = false) {
    const c = ctx; if (!c || !active || document.hidden || c.fetching || c.expired) return;
    c.fetching = true; const hadCursor = c.newest; controls();
    try {
      const result = await rpc('tt_chat_list', { p_code: c.code, p_peer: c.peer, p_before: older ? c.oldest : null, p_after: !older ? c.newest : null, p_limit: 50 });
      if (c !== ctx) return;
      if (!Array.isArray(result?.messages)) throw Error('Unexpected chat response.');
      const existing = new Set(c.messages.map((m) => m.id)), fresh = result.messages.filter((m) => !existing.has(m.id));
      if (older) c.messages = [...fresh, ...c.messages]; else c.messages.push(...fresh);
      if (older || !c.loaded) { c.hasOlder = !!result.hasMore; c.oldest = result.oldestId || c.oldest; }
      if (!older) c.newest = result.newestId || c.newest;
      const initial = !c.loaded; c.loaded = true; c.online = true;
      if (fresh.length || initial) renderMessages(older, initial);
      $('chatConnection').textContent = 'Live while open';
      await acknowledge();
      if (!older && hadCursor && result.hasMore && result.messages.length && c === ctx) c.catchUp = true;
    } catch (e) { fail(c, e); }
    finally { c.fetching = false; if (c === ctx) { controls(); if (c.catchUp) { c.catchUp = false; setTimeout(() => { if (c === ctx) pull(); }, 100); } } }
  }

  function onRoom(room) {
    if (!room) {
      ctx = null; active = false; drafts.clear();
      $('chatMessages').replaceChildren(); $('chatThreads').replaceChildren(); $('chatBody').value = ''; $('chatBadge').hidden = true; feedback(''); return;
    }
    const seat = room.isHost ? -1 : room.me;
    if (ctx?.key === room.code + ':' + seat) {
      // Names can change in the lobby and new players can arrive: refresh thread names without losing state.
      if (room.phase === 'lobby' && ctx.threads.length !== 1 + (seat !== -1 ? 1 : 0) + room.players.filter((p) => !p.isTestSeat && p.id !== seat).length) inbox();
      return;
    }
    drafts.clear(); ctx = blankContext(room, seat);
    try {
      const p = JSON.parse(sessionStorage.getItem(storageKey(ctx)) || 'null');
      if (p?.args?.p_code === ctx.code && p.seat === seat && typeof p.args.p_body === 'string' && typeof p.args.p_request === 'string' && (p.args.p_peer === null || Number.isInteger(p.args.p_peer))) { ctx.pending = p; ctx.peer = p.args.p_peer; }
    } catch { /* ignore unreadable storage */ }
    $('chatBody').value = ctx.pending?.args.p_body || '';
    feedback(ctx.pending ? 'An earlier message was never confirmed. Retry it; do not type it again.' : '');
    renderThreads(); renderMessages(); inbox();
  }
  function open(peer) {
    const c = ctx; if (!c) return;
    if (c.pending || c.sending) { feedback('Confirm your pending message before changing conversations.'); return; }
    if (!c.threads.some((t) => t.peer === peer)) { feedback('Choose another real member of this room.'); return; }
    if (c.peer === peer) { if (active) pull(); return; }
    drafts.set(peerKey(c.peer), $('chatBody').value);
    // A fresh context: answers still in flight for the previous conversation fail the `c === ctx` test.
    ctx = { ...blankContext(getRoom(), c.seat), threads: c.threads, peer, online: c.online };
    $('chatBody').value = drafts.get(peerKey(peer)) || ''; feedback('');
    renderThreads(); renderMessages(); if (active) pull();
  }
  function setActive(value) { const changed = active !== value; active = value; if (value && ctx && changed) { renderThreads(); pull(); inbox(); } }

  async function send(retry = false) {
    const c = ctx; if (!c || c.sending || c.expired) return;
    if (!retry && (c.pending || !c.online)) return;
    const body = $('chatBody').value.trim(); if (!retry && (!body || body.length > 1000)) return;
    const pending = retry ? c.pending : { seat: c.seat, args: { p_code: c.code, p_request: crypto.randomUUID(), p_peer: c.peer, p_body: body, p_reply: c.replyTo?.id ?? null } };
    if (!pending) return;
    savePending(c, pending); c.sending = true; controls(); feedback('Sending…');
    try {
      const message = await rpc('tt_chat_send', pending.args);
      if (!message?.id) throw Error('Message confirmation unavailable');
      savePending(c, null);
      if (c === ctx) { $('chatBody').value = ''; c.replyTo = null; drafts.delete(peerKey(c.peer)); feedback('Sent.'); c.online = true; c.sending = false; controls(); await pull(); inbox(); }
    } catch (e) {
      if (c !== ctx) return;
      // A definite server answer clears the pending message; silence (network loss) keeps it for a safe retry.
      if (e?.code && !String(e.code).startsWith('5')) { savePending(c, null); feedback(errorText(e)); if (/expired/i.test(e.message || '')) fail(c, e); }
      else feedback('Delivery is unconfirmed. Retry the same message — it will not be sent twice.');
    } finally { c.sending = false; if (c === ctx) controls(); }
  }

  $('chatForm').onsubmit = (e) => { e.preventDefault(); send(); };
  $('chatBody').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); } };
  $('chatRetry').onclick = () => send(true);
  $('chatReconnect').onclick = () => { inbox(); pull(); };
  $('chatBody').oninput = controls;
  $('chatReplyCancel').onclick = () => { if (ctx) { ctx.replyTo = null; controls(); } };
  $('chatThreadSelect').onchange = () => open($('chatThreadSelect').value === 'room' ? null : Number($('chatThreadSelect').value));
  $('chatOlder').onclick = () => pull(true);
  $('chatNew').onclick = () => { $('chatMessages').scrollTop = $('chatMessages').scrollHeight; acknowledge(); $('chatNew').hidden = true; };
  let scrollTimer;
  $('chatMessages').onscroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { if (ctx && nearBottom()) { acknowledge(); $('chatNew').hidden = true; } }, 200); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (getRoom()) inbox(); if (active) pull(); } });
  setInterval(() => { if (active) pull(); }, 4000);
  setInterval(() => { if (getRoom()) inbox(); }, 12000);
  return { onRoom, setActive, open };
}
