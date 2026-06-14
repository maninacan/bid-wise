import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DelegatedTakeoff } from '../lib/supabase';
import { getMyDelegatedTakeoffs } from '../lib/supabase';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

export function MyWorkScreen() {
  const navigate = useNavigate();
  const [delegated, setDelegated] = useState<DelegatedTakeoff[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyDelegatedTakeoffs()
      .then(setDelegated)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="mt-10 w-full">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">My Work</h1>
        <p className="mt-1 text-sm text-slate-500">
          Takeoff sections delegated to you by general contractors.
        </p>
      </div>

      {loading && (
        <p className="mt-10 text-center text-sm text-slate-500">Loading…</p>
      )}

      {!loading && delegated.length === 0 && (
        <div className="mt-10 rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <p className="text-sm text-slate-500">No delegated work yet.</p>
          <p className="mt-1 text-xs text-slate-400">
            When a contractor delegates a trade section to you, it will appear here.
          </p>
        </div>
      )}

      {!loading && delegated.length > 0 && (
        <div className="mt-6 space-y-3">
          {delegated.map((takeoff) => (
            <button
              key={takeoff.id}
              type="button"
              onClick={() =>
                navigate(`/projects/${takeoff.plan_id}/takeoffs/${takeoff.id}`)
              }
              className="w-full rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50/40"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold text-slate-800">
                    {takeoff.data.projectName}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {fmtDate(takeoff.created_at)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {takeoff.myDelegatedTrades.map((trade) => (
                    <span
                      key={trade}
                      className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-700"
                    >
                      {trade}
                    </span>
                  ))}
                </div>
              </div>
              {takeoff.data.summary && (
                <p className="mt-2 line-clamp-2 text-sm text-slate-500">
                  {takeoff.data.summary}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
