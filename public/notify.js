// Notification settings. The browser permission prompt appears ONLY after the user presses
// "Turn on notifications". An in-app preference is never treated as browser permission.
import { $, text, node } from './ui.js?v=1.0.1';
import { VAPID_PUBLIC_KEY } from './push-config.js?v=1.0.1';

const LABELS = {
  income: 'Daily income', dm: 'Direct messages', eliminated: 'Your elimination',
  bonus: 'Vote bonuses and points given to you', movement: 'Public movement', rules: 'Approved rule changes',
  match: 'Match opening and ending', review: 'Proposal reviews (and, for hosts, new proposals)',
};
const b64ToBytes = (value) => { const pad = '='.repeat((4 - value.length % 4) % 4), raw = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const bytesToB64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createNotifications({ rpc, isSignedIn }) {
  let server = null, busy = false;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const say = (message) => text('notifyFeedback', message);

  async function subscription() {
    if (!supported) return null;
    try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
  }

  async function render() {
    if (!isSignedIn()) { $('notifyCard').hidden = true; return; }
    $('notifyCard').hidden = false;
    const sub = await subscription(), permission = supported ? Notification.permission : 'unsupported';
    let status, canEnable = false;
    if (!supported) status = iOS && !standalone ? 'Not available in this browser tab. On iPhone and iPad, add Turn Tactics to your Home Screen and open it from there.' : 'This browser does not support background notifications.';
    else if (!VAPID_PUBLIC_KEY) status = 'Pending setup: background delivery has not been configured for this site yet. Your choices below are saved and will apply once it is.';
    else if (permission === 'denied') status = 'Blocked in this browser’s site settings. Allow notifications for this site there, then return.';
    else if (sub && permission === 'granted') status = 'On for this device.';
    else { status = 'Off on this device. Get a quiet nudge when daily income arrives, when someone messages you directly, or if you are eliminated.'; canEnable = true; }
    text('notifyStatus', status);
    $('notifyEnable').hidden = !canEnable; $('notifyDisable').hidden = !(sub && permission === 'granted');
    $('notifyPrefs').hidden = !server;
    if (server) {
      $('notifyList').replaceChildren(...Object.keys(LABELS).map((key) => {
        const label = node('label', undefined, 'check'), box = node('input');
        box.type = 'checkbox'; box.checked = !!server.prefs[key]; box.disabled = busy;
        box.onchange = () => save({ [key]: box.checked });
        label.append(box, node('span', LABELS[key])); return label;
      }));
    }
  }

  async function load() {
    if (!isSignedIn()) { server = null; return render(); }
    try { server = await rpc('tt_push_prefs', {}); } catch { server = null; text('notifyStatus', 'Notification settings are unavailable until the server is upgraded (migration 021).'); }
    await render();
    // Keep the server's copy of this device current (keys can rotate; the account may have changed).
    const sub = await subscription();
    if (sub && server && Notification.permission === 'granted') register(sub).catch(() => {});
  }

  async function register(sub) {
    const json = sub.toJSON();
    server = await rpc('tt_push_subscribe', { p_endpoint: sub.endpoint, p_p256dh: json.keys?.p256dh || bytesToB64(sub.getKey('p256dh')), p_auth: json.keys?.auth || bytesToB64(sub.getKey('auth')) });
  }

  async function save(patch) {
    if (busy) return; busy = true;
    try { server = await rpc('tt_push_prefs_save', { p_prefs: patch }); say('Saved.'); } catch (e) { say(e.message || 'Could not save.'); }
    busy = false; render();
  }

  $('notifyEnable').onclick = async () => {
    if (busy) return; busy = true; say('');
    try {
      const permission = await Notification.requestPermission(); // direct result of this click
      if (permission !== 'granted') { say(permission === 'denied' ? 'Notifications were blocked. You can allow them later in this browser’s site settings.' : 'No permission given. Nothing was changed.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
      await register(sub); say('Notifications are on for this device.');
    } catch (e) { say('Could not turn notifications on: ' + (e.message || 'unknown error')); }
    finally { busy = false; render(); }
  };
  $('notifyDisable').onclick = async () => { if (busy) return; busy = true; await disableDevice(); say('Notifications are off for this device.'); busy = false; render(); };

  /** Removes this device's subscription locally and on the server. Call before signing out. */
  async function disableDevice() {
    const sub = await subscription();
    if (!sub) return;
    try { server = await rpc('tt_push_unsubscribe', { p_endpoint: sub.endpoint }); } catch { /* signed out already: the browser side still goes */ }
    try { await sub.unsubscribe(); } catch { /* nothing more to do */ }
  }

  if (supported) navigator.serviceWorker.addEventListener('message', (event) => { if (event.data?.type === 'tt-resubscribe') load(); });
  return { load, render, disableDevice };
}
