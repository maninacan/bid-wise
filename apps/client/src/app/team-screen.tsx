import { useEffect, useState } from 'react';
import {
  companyInvites,
  companyMembers,
  inviteTeamMember,
  removeTeamMember,
  revokeInvite,
  type CompanyInvite,
  type CompanyMember,
} from '../lib/supabase';
import { useCompany } from '../lib/company-context';

export function TeamScreen() {
  const { activeCompany } = useCompany();
  const companyId = activeCompany?.company.id ?? null;
  const isOwner = activeCompany?.role === 'owner';

  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [invites, setInvites] = useState<CompanyInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([companyMembers(companyId), companyInvites(companyId)])
      .then(([m, i]) => {
        if (cancelled) return;
        setMembers(m);
        setInvites(i.filter((invite) => invite.status === 'pending'));
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load team.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      const invite = await inviteTeamMember(companyId, inviteEmail.trim());
      setInvites((prev) => [invite, ...prev]);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not send invite.');
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    setBusyId(inviteId);
    try {
      await revokeInvite(inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke invite.');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!companyId) return;
    setBusyId(userId);
    try {
      await removeTeamMember(companyId, userId);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove team member.');
    } finally {
      setBusyId(null);
    }
  };

  if (!companyId) {
    return <p className="mt-10 text-sm text-slate-500">No active company.</p>;
  }

  return (
    <div className="mt-10 w-full max-w-2xl">
      <h2 className="text-lg font-semibold text-slate-900">Team</h2>
      <p className="mt-1 text-sm text-slate-500">
        {activeCompany?.company.name} — everyone here shares projects, subs, and billing.
      </p>

      {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="mt-8 text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <table className="mt-6 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-b border-slate-100">
                  <td className="py-3 pr-4 font-medium text-slate-800">{m.email}</td>
                  <td className="py-3 pr-4 capitalize text-slate-600">{m.role}</td>
                  <td className="py-3 text-right">
                    {isOwner && m.role !== 'owner' && (
                      <button
                        type="button"
                        onClick={() => handleRemove(m.userId)}
                        disabled={busyId === m.userId}
                        className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      >
                        {busyId === m.userId ? '…' : 'Remove'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {isOwner && (
            <div className="mt-8">
              <h3 className="text-sm font-semibold text-slate-800">Invite a teammate</h3>
              <form onSubmit={handleInvite} className="mt-2 flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={inviting || !inviteEmail.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
                >
                  {inviting ? 'Sending…' : 'Invite'}
                </button>
              </form>
              {inviteError && <p className="mt-2 text-xs text-red-600">{inviteError}</p>}

              {invites.length > 0 && (
                <div className="mt-6">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">Pending invites</h4>
                  <ul className="mt-2 space-y-2">
                    {invites.map((invite) => (
                      <li
                        key={invite.id}
                        className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                      >
                        <span className="text-sm text-slate-700">{invite.email}</span>
                        <button
                          type="button"
                          onClick={() => handleRevoke(invite.id)}
                          disabled={busyId === invite.id}
                          className="text-xs font-medium text-red-400 hover:text-red-600 disabled:opacity-40"
                        >
                          {busyId === invite.id ? '…' : 'Revoke'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
