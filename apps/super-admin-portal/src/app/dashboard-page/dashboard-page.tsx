import { useCallback, useEffect, useState } from 'react';
import { gql } from '@apollo/client';
import { apolloClient } from '@bid-wise/data';
import { authContext } from '../../lib/supabase';

interface RecentTakeoff {
  id: string;
  userEmail: string;
  companyName: string | null;
  planName: string | null;
  createdAt: string;
}

interface AdminDashboardStats {
  totalUsers: number;
  totalTakeoffs: number;
  totalCompanies: number;
  totalCreditsToppedUpCents: number;
  totalCreditsSpentCents: number;
  totalAiTokens: number;
  recentTakeoffs: RecentTakeoff[];
}

const ADMIN_DASHBOARD_STATS = gql`
  query AdminDashboardStats {
    adminDashboardStats {
      totalUsers
      totalTakeoffs
      totalCompanies
      totalCreditsToppedUpCents
      totalCreditsSpentCents
      totalAiTokens
      recentTakeoffs {
        id
        userEmail
        companyName
        planName
        createdAt
      }
    }
  }
`;

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function KpiCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 text-slate-400">
        <i className={`fa-light fa-${icon}`} aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function DashboardPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apolloClient.query<{ adminDashboardStats: AdminDashboardStats }>({
        query: ADMIN_DASHBOARD_STATS,
        context: await authContext(),
        fetchPolicy: 'network-only',
      });
      setStats(data!.adminDashboardStats);
    } catch {
      setError('Could not load dashboard stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-wait"
        >
          <i className="fa-light fa-arrows-rotate mr-1.5" aria-hidden="true" />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="mt-6 text-sm text-red-600">{error}</p>}

      {stats && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <KpiCard label="Users" value={stats.totalUsers.toLocaleString()} icon="users" />
            <KpiCard label="Companies" value={stats.totalCompanies.toLocaleString()} icon="building" />
            <KpiCard label="Takeoffs generated" value={stats.totalTakeoffs.toLocaleString()} icon="ruler-combined" />
            <KpiCard label="Credits topped up" value={formatCents(stats.totalCreditsToppedUpCents)} icon="wallet" />
            <KpiCard label="Credits spent" value={formatCents(stats.totalCreditsSpentCents)} icon="receipt" />
          </div>

          <div className="mt-4">
            <KpiCard label="AI tokens used" value={formatTokens(stats.totalAiTokens)} icon="microchip" />
          </div>

          <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">
              Recent takeoffs
            </h2>
            {stats.recentTakeoffs.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-400">No takeoffs yet.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-5 py-2 font-medium">User</th>
                    <th className="px-5 py-2 font-medium">Company</th>
                    <th className="px-5 py-2 font-medium">Plan</th>
                    <th className="px-5 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentTakeoffs.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-5 py-2.5 text-slate-700">{t.userEmail}</td>
                      <td className="px-5 py-2.5 text-slate-500">{t.companyName ?? '—'}</td>
                      <td className="px-5 py-2.5 text-slate-500">{t.planName ?? '—'}</td>
                      <td className="px-5 py-2.5 text-slate-500">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default DashboardPage;
