// Accounts: registration, username-or-email sign-in, password reset, guest (anonymous) upgrade.
// Uses Supabase Auth only; there is no custom password store. Credentials are never logged or stored here.
import { $, text } from './ui.js?v=1.0.1';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './online-config.js';

const GENERIC = 'Those sign-in details did not match. Check them and try again.';
const USERNAME = /^[a-z0-9_]{3,20}$/;
// Supabase Auth identifies every account by an address. An account made without an email gets this
// placeholder instead: the reserved “.invalid” domain cannot receive mail, and Auth refuses to send to it.
const NO_EMAIL = '@players.turntactics.invalid';
const TAKEN = 'That username is taken. If it is yours, sign in instead; otherwise choose another.';
const NEEDS_EMAIL = 'This server still requires a confirmed email for new accounts. Enter your email to register, or ask the host to turn off email confirmation.';
// Mirrors tt_name_reserved in SQL, so a name the server would refuse is caught before an identity exists for it.
const RESERVED = ['host', 'referee', 'hostreferee', 'roomchat', 'turntactics', 'system', 'admin', 'moderator'];
const reserved = (name) => RESERVED.includes(name.replace(/[^A-Za-z]/g, '').toLowerCase()) || name.trim().toLowerCase().startsWith('test seat');
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

export function createAccount({ db, rpc, onChange, getRememberedRoom }) {
  const account = { status: 'loading', user: null, profile: null, recovering: false };
  const say = (message) => text('homeFeedback', message);
  const redirectTo = () => location.origin + location.pathname;
  let busy = false;

  function setBusy(value) { busy = value; document.querySelectorAll('#homeCard button, #homeCard input').forEach((el) => { el.disabled = value; }); }
  async function guarded(work) {
    if (busy) return; setBusy(true);
    try { await work(); } catch (e) { say(e?.message || 'Something went wrong. Please try again.'); } finally { setBusy(false); }
  }

  // status: signedOut | guest (legacy anonymous) | needsProfile | ready | recovery | backendPending
  async function load() {
    const { data } = await db.auth.getSession();
    const user = data?.session?.user || null;
    account.user = user; account.profile = null;
    if (account.recovering && user) account.status = 'recovery';
    else if (!user) account.status = 'signedOut';
    else if (user.is_anonymous) account.status = 'guest';
    else {
      try {
        account.profile = await rpc('tt_profile', {});
        account.status = account.profile?.hasProfile ? 'ready' : 'needsProfile';
      } catch (e) {
        account.status = e?.code === 'PGRST202' ? 'backendPending' : 'needsProfile';
      }
    }
    render(); onChange(account);
    return account;
  }
  // Auth events refresh too. One at a time, so a slow older answer can never overwrite a newer one.
  let queue = Promise.resolve();
  const refresh = () => (queue = queue.then(load, load));

  function showTab(register) {
    $('signInForm').hidden = register; $('registerForm').hidden = !register; $('resetForm').hidden = true;
    $('tabSignIn').setAttribute('aria-selected', String(!register)); $('tabRegister').setAttribute('aria-selected', String(register));
  }

  function render() {
    const s = account.status, guest = s === 'guest', remembered = getRememberedRoom();
    $('authPanel').hidden = !(s === 'signedOut' || guest);
    $('newPasswordForm').hidden = s !== 'recovery';
    $('profileForm').hidden = s !== 'needsProfile';
    $('entryPanel').hidden = s !== 'ready';
    $('guestPanel').hidden = !guest;
    $('guestUpgradeNote').hidden = !guest;
    $('carryWrap').hidden = !(guest && remembered); if (remembered) text('carryRoom', remembered);
    if (s === 'needsProfile') {
      const meta = account.user?.user_metadata || {};
      if (!$('profileUsername').value) $('profileUsername').value = meta.username || '';
      if (!$('profileDisplay').value) $('profileDisplay').value = meta.display_name || '';
      // A guest who has just confirmed an email still needs a password before the account is usable elsewhere.
      $('profilePasswordWrap').hidden = !meta.needs_password; $('profilePassword').required = !!meta.needs_password;
    }
    if (s === 'ready') {
      // The two names differ only when the username had to change after the sign-in name was already fixed.
      const email = account.user.email || '', login = email.endsWith(NO_EMAIL) ? email.slice(0, -NO_EMAIL.length) : account.profile.username;
      text('whoAmI', `${account.profile.displayName} (@${account.profile.username})` + (login === account.profile.username ? '' : ` · sign-in name: ${login}`));
    }
    if (s === 'backendPending') say('The server has not been upgraded for accounts yet (migration 020 onward). Existing rooms still open below.');
    if (s === 'loading') say('Connecting…');
  }

  async function saveProfile(username, display) {
    account.profile = await rpc('tt_profile_save', { p_username: username, p_display: display });
  }

  async function signIn(identifier, password) {
    const id = identifier.trim().toLowerCase();
    if (id.includes('@')) {
      const { error } = await db.auth.signInWithPassword({ email: id, password });
      if (error) throw Error(/confirm/i.test(error.message) ? 'Confirm your email first: open the link we sent, then sign in. If that link has expired, create the account again to get a new one.' : GENERIC);
      return;
    }
    if (!USERNAME.test(id)) throw Error(GENERIC);
    // An account made without an email signs in directly, through its placeholder address.
    const direct = await db.auth.signInWithPassword({ email: id + NO_EMAIL, password });
    if (!direct.error) return;
    if (!direct.error.status) throw Error('Could not reach the sign-in service. Check your connection and try again.');
    if (direct.error.status === 429) throw Error('Too many attempts. Wait a few minutes and try again.');
    // Otherwise the username may belong to an account that has an email. Only the server can resolve that
    // (the tt-login function, where it is deployed); the browser never receives an email address.
    const useEmail = GENERIC + ' If you registered with an email, sign in with that email instead of your username.';
    let response;
    try {
      response = await fetch(`${SUPABASE_URL}/functions/v1/tt-login`, { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY }, body: JSON.stringify({ identifier: id, password }) });
    } catch { throw Error(useEmail); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw Error(response.status === 429 && body.error ? body.error : [403, 404, 503].includes(response.status) ? useEmail : GENERIC);
    const { error } = await db.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
    if (error) throw Error(GENERIC);
  }

  // Why Supabase Auth refused an address. Without an email the username is the address, so a duplicate
  // means the name is in use, and a mail error means the server still wants to confirm an email.
  function refusal(error, typed, duplicate) {
    if (/already|registered|exists/i.test(error.message)) return typed ? duplicate : TAKEN;
    return !typed && /e-?mail/i.test(error.message) ? NEEDS_EMAIL : error.message;
  }

  $('tabSignIn').onclick = () => showTab(false); $('tabRegister').onclick = () => showTab(true);
  $('showReset').onclick = () => { $('signInForm').hidden = true; $('resetForm').hidden = false; $('resetEmail').focus(); };
  $('cancelReset').onclick = () => showTab(false);

  $('signInForm').onsubmit = (e) => { e.preventDefault(); guarded(async () => {
    const guest = account.status === 'guest', room = getRememberedRoom(), carry = guest && room && $('carrySeat').checked;
    let token = null;
    if (carry) {
      // Explicit transfer: the guest proves ownership by minting a fresh recovery code, which the
      // account then redeems. Nothing is merged on the strength of a name.
      token = randomHex();
      await rpc('tt_save_recovery', { p_code: room, p_token: token });
    }
    await signIn($('signInId').value, $('signInPassword').value);
    $('signInPassword').value = '';
    await refresh();
    if (token && account.status === 'ready') {
      try {
        const moved = await rpc('tt_recover', { p_code: room, p_token: token });
        say(moved?.error ? 'Signed in, but the guest role could not be moved: ' + moved.error : 'Signed in. Your role in that room now belongs to this account.');
      } catch (err) { say('Signed in, but the guest role was not moved: ' + (err.message || 'unknown reason') + ' Its recovery code was replaced; create a new one from that identity if you still can.'); }
    } else if (token) say('Signed in. Finish your profile, then restore your earlier role with its recovery code.');
    else say('');
  }); };

  $('registerForm').onsubmit = (e) => { e.preventDefault(); guarded(async () => {
    const typed = $('regEmail').value.trim().toLowerCase(), username = $('regUsername').value.trim().toLowerCase(), display = $('regDisplay').value.trim(), password = $('regPassword').value;
    if (!USERNAME.test(username)) throw Error('Usernames use 3–20 letters, numbers or underscores.');
    if (reserved(username) || reserved(display)) throw Error('That name is reserved. Choose another.');
    if (password.length < 8) throw Error('Use a password of at least 8 characters.');
    const email = typed || username + NO_EMAIL;
    if (account.status === 'guest') {
      // Upgrade in place: the user id (and so every seat, image, proposal and message) is unchanged.
      const { error } = await db.auth.updateUser({ email, data: { username, display_name: display, needs_password: true } });
      if (error) throw Error(refusal(error, typed, 'That email already has an account. Sign in to it instead and carry your role over.'));
      const { error: passwordError } = await db.auth.updateUser({ password });
      if (!passwordError) await db.auth.updateUser({ data: { needs_password: false } });
      $('regPassword').value = '';
      await refresh();
      if (account.status === 'guest') { say(typed ? 'Check your email and open the confirmation link on this device. Then return here to set your password and finish the account. Your seats stay with this browser meanwhile.' : NEEDS_EMAIL); return; }
      if (passwordError) { say('Nearly there: choose a password below to finish. ' + passwordError.message); return; }
      // No confirmation step on this server, so finish the profile now instead of asking for the same details again.
      await saveProfile(username, display); await refresh();
      say('Account created. Your existing seats came with you.');
      return;
    }
    const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo(), data: { username, display_name: display } } });
    if (error) throw Error(refusal(error, typed, 'That email already has an account. Sign in instead, or reset its password.'));
    $('regPassword').value = '';
    if (!data?.session) {
      if (!typed) throw Error(NEEDS_EMAIL);
      showTab(false); say('Almost there: open the confirmation link we emailed you, then sign in. If the address already has an account, sign in or reset its password instead.');
      return;
    }
    try { await saveProfile(username, display); say(''); } catch (err) {
      // The name belongs to an account that signs in by email, so this new identity can never use it. Lock it
      // with a password nobody knows before leaving; otherwise signing in with these same details would land in it.
      if (!typed && /taken/i.test(err.message)) { await db.auth.updateUser({ password: randomHex() }); await db.auth.signOut(); await refresh(); throw Error(TAKEN); }
      say(err.message);
    }
    await refresh();
  }); };

  $('resetForm').onsubmit = (e) => { e.preventDefault(); guarded(async () => {
    await db.auth.resetPasswordForEmail($('resetEmail').value.trim().toLowerCase(), { redirectTo: redirectTo() });
    // Same answer whether or not the address exists.
    showTab(false); say('If that email has an account, a reset link is on its way. Open it on this device.');
  }); };

  $('newPasswordForm').onsubmit = (e) => { e.preventDefault(); guarded(async () => {
    const { error } = await db.auth.updateUser({ password: $('newPassword').value });
    if (error) throw Error(error.message);
    $('newPassword').value = ''; account.recovering = false; await refresh(); say('Password updated.');
  }); };

  $('profileForm').onsubmit = (e) => { e.preventDefault(); guarded(async () => {
    const username = $('profileUsername').value.trim().toLowerCase();
    if (!USERNAME.test(username)) throw Error('Usernames use 3–20 letters, numbers or underscores.');
    if (!$('profilePasswordWrap').hidden) {
      const { error } = await db.auth.updateUser({ password: $('profilePassword').value, data: { needs_password: false } });
      if (error) throw Error(error.message);
      $('profilePassword').value = '';
    }
    await saveProfile(username, $('profileDisplay').value.trim());
    await refresh(); say('');
  }); };

  db.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { account.recovering = true; refresh(); }
    else if (event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(refresh, 0);
  });

  return {
    account, refresh,
    async saveDisplayName(display) { await saveProfile(account.profile.username, display); await refresh(); },
    async signOut() { await db.auth.signOut(); account.recovering = false; await refresh(); },
  };
}
