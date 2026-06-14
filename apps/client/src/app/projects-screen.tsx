import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HousePlan } from '../lib/supabase';
import { supabase } from '../lib/supabase';

interface ProjectsScreenProps {
  plans: HousePlan[];
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const projectName = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

export function ProjectsScreen({ plans }: ProjectsScreenProps) {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});

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
                    {projectName(plan.file_name)}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-slate-500">
                    {fmtDate(plan.created_at)}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-slate-500">
                    {counts[plan.id] ?? 0}
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
