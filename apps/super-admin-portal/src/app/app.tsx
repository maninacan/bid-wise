import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { BidWiseLogo } from '@bid-wise/common-components';
import { supabase, signIn, signOut, isSuperAdmin } from '../lib/supabase';
import DashboardPage from './dashboard-page/dashboard-page';
import UsersPage from './users-page/users-page';
import SettingsPage from './settings-page/settings-page';

function AdminSignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      // onAuthStateChange in App handles the rest.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6">
      <BidWiseLogo size="sm" />
      <div className="mt-8 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-sm font-semibold text-slate-500">
          Super Admin Console
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

function NotAuthorizedScreen({ email }: { email: string | undefined }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <BidWiseLogo size="sm" />
      <div className="mt-8 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-base font-semibold text-slate-900">Not a Super Admin</h1>
        <p className="mt-2 text-sm text-slate-500">
          {email} is signed in but doesn't have access to the Super Admin Console.
        </p>
        <button
          type="button"
          onClick={() => signOut().catch(() => {})}
          className="mt-6 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: string;
  children: string;
}

function NavItem({ to, icon, children }: NavItemProps) {
  const location = useLocation();
  const current = location.pathname.startsWith(to);
  return (
    <li>
      <Link
        to={to}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          current
            ? 'bg-blue-50 text-blue-700'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
        }`}
      >
        <i className={`fa-light fa-${icon} w-4 text-center`} aria-hidden="true" />
        {children}
      </Link>
    </li>
  );
}

function AdminShell({ session }: { session: Session }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <div className="flex w-56 flex-col border-r border-slate-200 bg-white px-4 py-6">
        <div className="mb-8 px-2">
          <BidWiseLogo size="sm" />
        </div>
        <ul className="flex-1 space-y-1">
          <NavItem to="/dashboard" icon="chart-line">Dashboard</NavItem>
          <NavItem to="/users" icon="users">Users</NavItem>
          <NavItem to="/settings" icon="gear">Settings</NavItem>
        </ul>
        <div className="border-t border-slate-200 pt-4">
          <p className="truncate px-2 text-xs text-slate-400">{session.user.email}</p>
          <button
            type="button"
            onClick={() => signOut().catch(() => {})}
            className="mt-2 w-full rounded-lg px-2 py-2 text-left text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            Sign out
          </button>
        </div>
      </div>

      <main className="flex-1 px-10 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (cancelled) return;
      setSession(s);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50" />;
  }

  if (!session) {
    return <AdminSignInScreen />;
  }

  if (!isSuperAdmin(session.user)) {
    return <NotAuthorizedScreen email={session.user.email} />;
  }

  return <AdminShell session={session} />;
}

export default App;
