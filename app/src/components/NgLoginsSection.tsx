'use client';

// Step 3 of the NG-login epic + issue #22 (login lifecycle): in-app management
// for the National Grid logins whose passwords are stored AES-256-GCM-encrypted
// (see lib/crypto.ts). Adding a login runs a real headless pre-flight login; if
// National Grid demands a one-time passcode, this surfaces a code input and
// resumes the live login. Issue #22 adds:
//   - Remove with a keep-vs-delete-data choice + a required password confirm.
//   - A "Not connected — re-authenticate" banner for logins flagged
//     needs_reauth, with a button that runs the SAME pre-flight + OTP UX as Add.
//
// Security: the password fields are write-only (type=password, never pre-filled).
// The add/confirm password is POSTed once; the server never returns it. The OTP
// is entered once and posted to the otp route — never persisted here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { relativeFromNow } from '@/lib/format';

interface NgLoginRow {
  id: number;
  label: string;
  username: string;
  status: string | null;
  lastVerifiedAt: string | null;
  accountCount: number;
}

type PreflightStatus = 'RUNNING' | 'AWAITING_OTP' | 'SUCCESS' | 'ERROR';

// Mask a username/email for display so a screen-share doesn't leak the full
// address. Keeps the first char + domain: `c••••@proton.me`.
function maskUsername(u: string): string {
  const at = u.indexOf('@');
  if (at <= 0) return u.length <= 2 ? u : u[0] + '••••';
  const local = u.slice(0, at);
  const domain = u.slice(at);
  const head = local[0];
  return `${head}${'•'.repeat(Math.max(2, local.length - 1))}${domain}`;
}

export function NgLoginsSection() {
  const [logins, setLogins] = useState<NgLoginRow[]>([]);
  const [secretKeyConfigured, setSecretKeyConfigured] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Add-login form state.
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Shared pre-flight / OTP state (Add AND Re-auth share the same machinery). A
  // running pre-flight is keyed by its id; `reauthLoginId` tags which login a
  // re-auth pre-flight belongs to (null = an Add), so the banner/row can reflect
  // it. AWAITING_OTP reveals the code input wherever the flow was started.
  const [preflightId, setPreflightId] = useState<string | null>(null);
  const [reauthLoginId, setReauthLoginId] = useState<number | null>(null);
  const [awaitingOtp, setAwaitingOtp] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);

  // Remove-confirmation modal state.
  const [confirmFor, setConfirmFor] = useState<NgLoginRow | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmDeleteData, setConfirmDeleteData] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const load = useCallback(async () => {
    const r = await fetch('/api/ng-logins', { cache: 'no-store' }).then((x) => x.json());
    setLogins(r.logins || []);
    setSecretKeyConfigured(Boolean(r.secretKeyConfigured));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    return stopPoll;
  }, [load]);

  const resetForm = () => {
    setLabel('');
    setUsername('');
    setPassword('');
  };

  // Resolve a terminal pre-flight state into UI + reload. Shared by Add + Re-auth.
  const finish = useCallback(
    (status: PreflightStatus, message: string) => {
      stopPoll();
      setBusy(false);
      setAwaitingOtp(false);
      setPreflightId(null);
      setReauthLoginId(null);
      setOtp('');
      if (status === 'SUCCESS') {
        setMsg(message || 'Login verified and saved.');
        setErr(null);
        resetForm();
        load();
      } else {
        setErr(message || 'Login failed.');
        setMsg(null);
        // Re-auth failures still want the row list refreshed (status may have moved).
        load();
      }
    },
    [load]
  );

  const poll = useCallback(
    (id: string) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/ng-logins/preflight/${id}`, { cache: 'no-store' });
          if (r.status === 404) {
            finish('ERROR', 'This login attempt expired. Please try again.');
            return;
          }
          if (!r.ok) return;
          const j: { status: PreflightStatus; message: string } = await r.json();
          if (j.status === 'AWAITING_OTP') {
            setAwaitingOtp(true);
            setMsg(j.message);
            return;
          }
          if (j.status === 'RUNNING') {
            if (!awaitingOtp) setMsg(j.message || 'Signing in…');
            return;
          }
          finish(j.status, j.message);
        } catch {
          /* keep polling */
        }
      }, 2000);
    },
    [awaitingOtp, finish]
  );

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setReauthLoginId(null);
    setMsg('Starting a login with National Grid…');
    try {
      const res = await fetch('/api/ng-logins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, username, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      // The plaintext password leaves this component here and never comes back;
      // clear it from state immediately.
      setPassword('');
      setPreflightId(j.preflightId);
      poll(j.preflightId);
    } catch (e2) {
      setBusy(false);
      setMsg(null);
      setErr((e2 as Error).message);
    }
  };

  // Kick off a re-auth pre-flight for an existing (needs_reauth) login. No
  // password is sent — the server decrypts the stored one. Reuses the SAME poll +
  // OTP machinery as Add.
  const startReauth = async (l: NgLoginRow) => {
    setBusy(true);
    setErr(null);
    setReauthLoginId(l.id);
    setMsg(`Re-authenticating "${l.label}" with National Grid…`);
    try {
      const res = await fetch(`/api/ng-logins/${l.id}/reauth`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setPreflightId(j.preflightId);
      poll(j.preflightId);
    } catch (e2) {
      setBusy(false);
      setMsg(null);
      setReauthLoginId(null);
      setErr((e2 as Error).message);
    }
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preflightId) return;
    setOtpBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/ng-logins/preflight/${preflightId}/otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: otp }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || `HTTP ${res.status}`);
        setOtpBusy(false);
        return;
      }
      // Accepted — clear the one-time code and let the poll carry it to terminal.
      setOtp('');
      setAwaitingOtp(false);
      setMsg('Verifying the code…');
      setOtpBusy(false);
    } catch (e2) {
      setOtpBusy(false);
      setErr((e2 as Error).message);
    }
  };

  const openConfirm = (l: NgLoginRow) => {
    setConfirmFor(l);
    setConfirmPassword('');
    setConfirmDeleteData(false);
    setConfirmErr(null);
  };
  const closeConfirm = () => {
    setConfirmFor(null);
    setConfirmPassword('');
    setConfirmDeleteData(false);
    setConfirmErr(null);
    setConfirmBusy(false);
  };

  const submitRemove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmFor) return;
    setConfirmBusy(true);
    setConfirmErr(null);
    try {
      const res = await fetch(`/api/ng-logins/${confirmFor.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteData: confirmDeleteData, password: confirmPassword }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 403 = wrong password; surface it without leaking anything.
        setConfirmErr(j.error || `HTTP ${res.status}`);
        setConfirmBusy(false);
        return;
      }
      closeConfirm();
      load();
    } catch (e2) {
      setConfirmErr((e2 as Error).message);
      setConfirmBusy(false);
    }
  };

  const needsReauth = logins.filter((l) => l.status === 'needs_reauth');
  // The OTP step renders inline in the Add form; if a re-auth is the one awaiting
  // a code, point the operator there too (single shared input).
  const reauthInProgress = reauthLoginId != null;

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">National Grid logins</h2>
        <p className="mt-1 text-xs text-slate-500">
          Credentials are stored encrypted (AES-256-GCM). Adding one runs a real login to verify it; if National Grid
          sends a one-time code you&apos;ll be asked for it here.
        </p>
      </div>

      {!secretKeyConfigured && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <code>NGRID_SECRET_KEY</code> isn&apos;t set, so the encrypted credential store is unavailable — you can&apos;t add a
          login until it&apos;s configured. Existing env credentials (<code>NGRID_USER</code>/<code>NGRID_PASS</code>) still work.
        </div>
      )}

      {/* Not-connected banner: any login flagged needs_reauth pauses scraping for
          that login until the operator re-authenticates. Existing data stays. */}
      {needsReauth.length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-200">
          <div className="font-medium">Not connected — re-authenticate</div>
          <div className="mt-1 space-y-2">
            {needsReauth.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-rose-200/90">
                  &ldquo;{l.label}&rdquo; ({maskUsername(l.username)}) needs re-authentication. Its data is kept, but
                  scheduled scraping is paused until you sign in again.
                </span>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => startReauth(l)}
                  disabled={busy || reauthInProgress}
                >
                  {reauthLoginId === l.id ? 'Re-authenticating…' : 'Re-authenticate'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Existing logins */}
      <div className="space-y-2">
        {logins.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-200">{l.label}</span>
                <span
                  className={`pill ${
                    l.status === 'verified'
                      ? 'border-emerald-500/40 text-emerald-300'
                      : l.status === 'needs_reauth'
                        ? 'border-rose-500/40 text-rose-300'
                        : 'opacity-70'
                  }`}
                >
                  {l.status === 'needs_reauth' ? 'not connected' : l.status || 'unknown'}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {maskUsername(l.username)} · {l.accountCount} account{l.accountCount === 1 ? '' : 's'} · verified{' '}
                {l.lastVerifiedAt ? relativeFromNow(l.lastVerifiedAt) : 'never'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {l.status === 'needs_reauth' && (
                <button
                  className="btn-primary"
                  onClick={() => startReauth(l)}
                  disabled={busy || reauthInProgress}
                >
                  {reauthLoginId === l.id ? 'Re-authenticating…' : 'Re-authenticate'}
                </button>
              )}
              <button
                className="btn border border-slate-700/70 bg-slate-800/40 text-rose-300 hover:bg-slate-700"
                onClick={() => openConfirm(l)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {loaded && logins.length === 0 && (
          <p className="text-sm text-slate-400">No stored logins yet. Add one below to verify and save it.</p>
        )}
      </div>

      {/* Add-login form */}
      <form onSubmit={submitAdd} className="space-y-3 border-t border-slate-800 pt-4">
        <div className="text-sm font-medium text-slate-200">Add a login</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Label</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
              placeholder="Home"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy || !secretKeyConfigured}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Username (email)</span>
            <input
              type="email"
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
              placeholder="you@example.com"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy || !secretKeyConfigured}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || !secretKeyConfigured}
            />
          </label>
        </div>

        {/* One-time code step — revealed when EITHER an Add or a Re-auth parks at
            OTP (one shared input). */}
        {awaitingOtp && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-3">
            <div className="text-sm font-medium text-amber-200">
              Enter the code National Grid just sent
              {reauthInProgress ? ' to re-authenticate' : ''}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-40 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm tracking-widest text-slate-100 outline-none focus:border-amber-500"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                disabled={otpBusy}
              />
              <button type="button" className="btn-primary" onClick={submitOtp} disabled={otpBusy || otp.trim() === ''}>
                {otpBusy ? 'Verifying…' : 'Submit code'}
              </button>
            </div>
          </div>
        )}

        {!awaitingOtp && !reauthInProgress && (
          <button type="submit" className="btn-primary" disabled={busy || !secretKeyConfigured}>
            {busy ? 'Verifying…' : 'Add login'}
          </button>
        )}

        {msg && <p className="text-xs text-slate-400">{msg}</p>}
        {err && <p className="text-xs text-rose-400">{err}</p>}
      </form>

      {/* Remove-confirmation modal: keep-vs-delete choice + required password. */}
      {confirmFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={submitRemove}
            className="w-full max-w-md space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-xl"
          >
            <div>
              <h3 className="text-base font-semibold text-slate-100">Remove “{confirmFor.label}”?</h3>
              <p className="mt-1 text-xs text-slate-400">
                Enter this login&apos;s National Grid password to confirm. By default the{' '}
                <strong className="text-slate-200">data is kept</strong> — {confirmFor.accountCount} account
                {confirmFor.accountCount === 1 ? '' : 's'} and all their bills, usage, and history stay on the
                dashboard; they just stop being tied to this login.
              </p>
            </div>

            <label className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmDeleteData}
                onChange={(e) => setConfirmDeleteData(e.target.checked)}
              />
              <span className="text-xs text-slate-300">
                <span className="font-medium text-rose-300">Also delete local data.</span> Permanently removes this
                login&apos;s {confirmFor.accountCount} account{confirmFor.accountCount === 1 ? '' : 's'} and every bill,
                usage row, cost, and downloaded PDF. This cannot be undone.
              </span>
            </label>

            <label className="block">
              <span className="text-xs text-slate-500">National Grid password</span>
              <input
                type="password"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-rose-500"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoFocus
              />
            </label>

            {confirmErr && <p className="text-xs text-rose-400">{confirmErr}</p>}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700"
                onClick={closeConfirm}
                disabled={confirmBusy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn border border-rose-700/70 bg-rose-900/40 text-rose-200 hover:bg-rose-800/60"
                disabled={confirmBusy || confirmPassword.trim() === ''}
              >
                {confirmBusy ? 'Removing…' : confirmDeleteData ? 'Remove and delete data' : 'Remove (keep data)'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
