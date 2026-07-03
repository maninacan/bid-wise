import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HousePlan } from '../lib/supabase';
import { listPlanTokenUsage, planDisplayName, renamePlan, supabase } from '../lib/supabase';

interface ProjectsScreenProps {
  plans: HousePlan[];
  /** Called after a project is renamed so the parent can refresh its plan list. */
  onPlanRenamed?: (plan: HousePlan) => void;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
    ? `${(n / 1_000).toFixed(1)}K`
    : String(n);

export function ProjectsScreen({ plans, onPlanRenamed }: ProjectsScreenProps) {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tokenUsage, setTokenUsage] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const startEdit = (plan: HousePlan) => {
    setEditingId(plan.id);
    setEditValue(planDisplayName(plan));
  };
  const saveEdit = async (plan: HousePlan) => {
    setSavingId(plan.id);
    try {
      const updated = await renamePlan(plan.id, editValue);
      onPlanRenamed?.(updated);
      setEditingId(null);
    } catch {
      // leave the editor open on failure
    } finally {
      setSavingId(null);
    }
  };

  useEffect(() => {
    if (plans.length === 0) return;
    const planIds = plans.map((p) => p.id);
    supabase
      .from('takeoffs')
      .select('plan_id')
      .in('plan_id', planIds)
      .then(({ data }) => {
        if (!data) return;
        const map: Record<string, number> = {};
        for (const row of data) {
          map[row.plan_id] = (map[row.plan_id] ?? 0) + 1;
        }
        setCounts(map);
      });
    listPlanTokenUsage(planIds).then(setTokenUsage).catch(() => {});
  }, [plans]);

  return (
    <section className="mt-10 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800">Projects</h1>
        <button
          type="button"
          onClick={() => navigate('/upload')}
          className="rounded-lg border-2 border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
        >
          Upload plans
        </button>
      </div>

      {plans.length === 0 ? (
        <p className="mt-10 text-center text-sm text-slate-500">No projects yet.</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 font-medium">Project</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Takeoffs</th>
                <th className="px-5 py-3 font-medium">AI tokens</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr
                  key={plan.id}
                  onClick={() => navigate(`/projects/${plan.id}`)}
                  className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50"
                >
                  <td className="px-5 py-3.5 font-medium text-slate-800">
                    {editingId === plan.id ? (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(plan);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          autoFocus
                          placeholder={plan.file_name.replace(/\.[^.]+$/, '')}
                          className="w-56 rounded border border-slate-300 px-2 py-1 text-sm font-normal focus:border-blue-400 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => saveEdit(plan)}
                          disabled={savingId === plan.id}
                          className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
                        >
                          {savingId === plan.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span>{planDisplayName(plan)}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); startEdit(plan); }}
                          title="Rename project"
                          className="rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-slate-500">
                    {fmtDate(plan.created_at)}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-slate-500">
                    {counts[plan.id] ?? 0}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-slate-400">
                    {tokenUsage[plan.id] != null ? fmtTokens(tokenUsage[plan.id]) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
