import { useState } from 'react';
import { Dialog } from './ui';
import { api } from './research';

export function Account({ email, close }: { email: string | null; close: () => void }) {
  const [mode, setMode] = useState<'register' | 'login'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(path: string, data?: unknown) {
    setBusy(true);
    try {
      await api('account/' + path, 'POST', data);
      window.location.hash = '#library';
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog title={email ? 'Your account' : 'Research account'} close={close} variant="modal">
      {email ? (
        <div className="form-card">
          <p>{email}</p>
          <button className="button secondary" disabled={busy} onClick={() => submit('logout')}>
            Sign out
          </button>
        </div>
      ) : (
        <form
          className="form-card review-form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void submit(mode, { email: data.get('email'), password: data.get('password') });
          }}
        >
          <p>
            {mode === 'register'
              ? 'Save this guest workspace to an account.'
              : 'Sign in to reopen your saved research.'}
          </p>
          <label>
            Email
            <input required type="email" name="email" autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={10}
              name="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? 'Create account' : 'Use existing account'}
            </button>
            <button disabled={busy} className="button primary">
              {mode === 'login' ? 'Sign in' : 'Register workspace'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
