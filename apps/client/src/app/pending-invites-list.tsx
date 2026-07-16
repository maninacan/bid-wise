import { useEffect, useState } from 'react';
import { acceptInvite, myPendingInvites, type Company, type CompanyInvite } from '../lib/supabase';

interface PendingInvitesListProps {
  onAccepted: (company: Company) => void | Promise<void>;
}

/** Lists pending invites addressed to the signed-in user's own email, each with an Accept
 *  button. Renders nothing while loading or once there are no pending invites. */
export function PendingInvitesList({ onAccepted }: PendingInvitesListProps) {
  const [invites, setInvites] = useState<CompanyInvite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

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
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      await onAccepted(company);
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not accept invite.');
    } finally {
      setAcceptingId(null);
    }
  };

  if (!loadingInvites && invites.length === 0) return null;

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
  );
}
