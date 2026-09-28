import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { BrandMark } from '../components';
import type { Admin } from '../types';

export function Login({ onLogin }: { onLogin: (admin: Admin) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin((await api.login(email, password)).admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card stack" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Queziva</div>
            <div className="brand-sub">Order management</div>
          </div>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
