import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { HousePlan, Takeoff } from '../lib/supabase';
import {
  archiveTakeoff,
  deleteTakeoff,
  getPlanSignedUrl,
  listTakeoffTokenUsage,
  listTakeoffs,
} from '../lib/supabase';

interface TakeoffsScreenProps {
  plans: HousePlan[];
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const fmtCurrency = (n: number) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
    ? `${(n / 1_000).toFixed(1)}K`
    : String(n);

function bidTotal(takeoff: Takeoff): number | null {
  const { bid, sections } = takeoff.data;
  if (!bid) return null;
  let direct = 0;
  for (const section of sections) {
    for (const item of section.items) {
      const key = `${section.trade}::${item.description}`;
      direct += item.quantity * (bid.prices[key] ?? 0);
    }
  }
  const mult = 1 + (bid.overheadPct + bid.profitPct + bid.contingencyPct) / 100;
  return direct * mult;
}

const projectName = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

// ── 3-dot actions menu ────────────────────────────────────────────────────────

interface ActionsMenuProps {
  onArchive: () => void;
  onDelete: () => void;
}

function ActionsMenu({ onArchive, onDelete }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative flex justify-end"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        aria-label="Actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          <button
            type="button"
            onClick={() => { setOpen(false); onArchive(); }}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            Archive
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); onDelete(); }}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Delete confirmation dialog ─────────────────────────────────────────────────

interface DeleteDialogProps {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteDialog({ name, onConfirm, onCancel }: DeleteDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Delete takeoff?</h2>
        <p className="mt-2 text-sm text-slate-500">
          <span className="font-medium text-slate-700">{name}</span> will be permanently deleted.
          This cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TakeoffsScreen ─────────────────────────────────────────────────────────────

export function TakeoffsScreen({ plans }: TakeoffsScreenProps) {
  const navigate = useNavigate();
  const { planId } = useParams<{ planId: string }>();
  const [takeoffs, setTakeoffs] = useState<Takeoff[]>([]);
  const [tokenUsage, setTokenUsage] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Takeoff | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const plan = planId ? plans.find((p) => p.id === planId) : null;

  useEffect(() => {
    if (!planId) return;
    setLoading(true);
    listTakeoffs(planId)
      .then((rows) => {
        setTakeoffs(rows);
        if (rows.length > 0) {
          listTakeoffTokenUsage(rows.map((r) => r.id))
            .then(setTokenUsage)
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [planId]);

  useEffect(() => {
    if (!plan?.storage_path) return;
    getPlanSignedUrl(plan.storage_path).then(setPdfUrl).catch(() => {});
  }, [plan?.storage_path]);

  const handleArchive = async (takeoff: Takeoff) => {
    setTakeoffs((prev) => prev.filter((t) => t.id !== takeoff.id));
    try {
      await archiveTakeoff(takeoff.id);
    } catch {
      setTakeoffs((prev) => [...prev, takeoff].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ));
    }
  };

  const handleDelete = async (takeoff: Takeoff) => {
    setDeleteTarget(null);
    setTakeoffs((prev) => prev.filter((t) => t.id !== takeoff.id));
    try {
      await deleteTakeoff(takeoff.id);
    } catch {
      setTakeoffs((prev) => [...prev, takeoff].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ));
    }
  };

  return (
    <section className="mt-10 w-full">
      {deleteTarget && (
        <DeleteDialog
          name={deleteTarget.data.projectName}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {plan && (
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="mb-5 flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          All projects
        </button>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800">
          {plan ? projectName(plan.file_name) : 'Quantity Takeoffs'}
        </h1>
        <button
          type="button"
          onClick={() => navigate(`/projects/${planId}/questionnaire`)}
          className="rounded-lg border-2 border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
        >
          New takeoffs
        </button>
      </div>

      {pdfUrl && (
        <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm w-1/2 mx-auto">
          <iframe
            src={pdfUrl}
            title="Plan PDF"
            className="h-[36vh] w-full"
          />
        </div>
      )}

      {loading ? (
        <p className="mt-10 text-center text-sm text-slate-500">Loading…</p>
      ) : takeoffs.length === 0 ? (
        <p className="mt-10 text-center text-sm text-slate-500">No takeoffs yet.</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 font-medium">Takeoff</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Trades</th>
                <th className="px-5 py-3 font-medium">Materials</th>
                <th className="px-5 py-3 font-medium">Bid</th>
                <th className="px-5 py-3 font-medium">AI tokens</th>
                <th className="px-5 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {takeoffs.map((takeoff) => {
                const total = bidTotal(takeoff);
                const tokens = tokenUsage[takeoff.id];
                return (
                  <tr
                    key={takeoff.id}
                    onClick={() => navigate(`/projects/${planId}/takeoffs/${takeoff.id}`)}
                    className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3.5 font-medium text-slate-800">
                      {takeoff.data.projectName}
                    </td>
                    <td className="px-5 py-3.5 tabular-nums text-slate-500">
                      {fmtDate(takeoff.created_at)}
                    </td>
                    <td className="px-5 py-3.5 tabular-nums text-slate-500">
                      {takeoff.data.sections.length}
                    </td>
                    <td className="px-5 py-3.5">
                      {takeoff.data.materialsSelectedTrades ? (
                        <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                          Generated
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                          Not started
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {total !== null ? (
                        <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                          {fmtCurrency(total)}
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                          Not started
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 tabular-nums text-slate-400">
                      {tokens != null ? fmtTokens(tokens) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <ActionsMenu
                        onArchive={() => handleArchive(takeoff)}
                        onDelete={() => setDeleteTarget(takeoff)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
