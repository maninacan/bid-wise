import { useEffect, useState } from 'react';
import { acceptInvite, createCompany, myPendingInvites, type CompanyInvite } from '../lib/supabase';
import { useCompany } from '../lib/company-context';
import { AppLogo } from './logo';

/** Shown when the signed-in user belongs to zero companies — a legitimate, potentially
 *  long-lived state (e.g. invited but hasn't accepted yet). Never auto-creates a company:
 *  the user either accepts a pending invite or explicitly creates their own. */
export function CompanyOnboardingScreen() {
  const { refresh } = useCompany();
  const [invites, setInvites] = useState<CompanyInvite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myPendingInvites()
      .then((list) => { if (!cancelled) setInvites(list); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingInvites(false); });
    return () => { cancelled = true; };
  }, []);

  const handleAccept = async (invite: CompanyInvite) => {
    if (!invite.token) return;
    setAcceptingId(invite.id);
    setAcceptError(null);
    try {
      const company = await acceptInvite(invite.token);
      await refresh(company.id);
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not accept invite.');
      setAcceptingId(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const company = await createCompany(name.trim());
      await refresh(company.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create company.');
      setCreating(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto flex max-w-md flex-col items-center">
        <AppLogo />

        {!loadingInvites && invites.length > 0 && (
          <div className="mt-10 w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">You've been invited</h2>
            <ul className="mt-4 space-y-3">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-600">Join a team on Bid Wise</span>
                  <button
                    type="button"
                    onClick={() => handleAccept(invite)}
                    disabled={acceptingId === invite.id}
                    className="shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:opacity-50"
                  >
                    {acceptingId === invite.id ? 'Joining…' : 'Accept'}
                  </button>
                </li>
              ))}
            </ul>
            {acceptError && <p className="mt-3 text-xs text-red-600">{acceptError}</p>}
          </div>
        )}

        <div className="mt-6 w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Create a company</h2>
          <p className="mt-1 text-sm text-slate-500">
            Set up your own company to start uploading plans and generating bids.
          </p>
          <form onSubmit={handleCreate} className="mt-4 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Smith Construction"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </form>
          {createError && <p className="mt-3 text-xs text-red-600">{createError}</p>}
        </div>
      </div>
    </main>
  );
}
