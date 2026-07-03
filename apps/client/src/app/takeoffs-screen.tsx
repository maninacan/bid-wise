import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { createPopper } from '@popperjs/core';
import type { HousePlan, Takeoff, TakeoffJob } from '../lib/supabase';
import {
  archiveTakeoff,
  deleteTakeoff,
  getActiveTakeoffJob,
  getPlanSignedUrl,
  listTakeoffTokenUsage,
  listTakeoffs,
  planDisplayName,
  priceTotal,
  renameTakeoff,
  subscribeTakeoffJob,
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
  const excluded = new Set(bid.excludedTrades ?? []);
  const excludedItems = new Set(bid.excludedItems ?? []);
  // Custom items live on the bid (not in the AI sections); count them alongside.
  const allItems: { trade: string; description: string; quantity: number }[] = [
    ...sections.flatMap((s) => s.items.map((it) => ({ trade: s.trade, description: it.description, quantity: it.quantity }))),
    ...(bid.customItems ?? []).map((c) => ({ trade: c.trade, description: c.description, quantity: c.quantity })),
  ];
  let direct = 0;
  for (const item of allItems) {
    if (excluded.has(item.trade)) continue;
    const key = `${item.trade}::${item.description}`;
    if (excludedItems.has(key)) continue;
    direct += item.quantity * priceTotal(bid.prices[key]);
  }
  const mult = 1 + (bid.overheadPct + bid.profitPct + bid.contingencyPct) / 100;
  return direct * mult;
}

// ── 3-dot actions menu ────────────────────────────────────────────────────────

interface ActionsMenuProps {
  onArchive: () => void;
  onDelete: () => void;
}

function ActionsMenu({ onArchive, onDelete }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the portaled menu with Popper so it escapes the table's overflow and
  // flips/shifts to stay within the viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const popper = createPopper(triggerRef.current, menuRef.current, {
      placement: 'bottom-end',
      modifiers: [
        { name: 'offset', options: { offset: [0, 4] } },
        { name: 'flip', options: { padding: 8 } },
        { name: 'preventOverflow', options: { padding: 8 } },
      ],
    });
    return () => popper.destroy();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
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

      {open && createPortal(
        <div
          ref={menuRef}
          className="z-50 w-36 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body,
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
  const [activeJob, setActiveJob] = useState<TakeoffJob | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const startEdit = (takeoff: Takeoff) => {
    setEditingId(takeoff.id);
    setEditValue(takeoff.data.projectName);
  };
  const saveEdit = async (takeoff: Takeoff) => {
    const name = editValue.trim();
    if (!name) return;
    setSavingId(takeoff.id);
    try {
      const updated = await renameTakeoff(takeoff.id, name);
      setTakeoffs((prev) => prev.map((t) => (t.id === takeoff.id ? { ...t, data: updated } : t)));
      setEditingId(null);
    } catch {
      // leave the editor open on failure
    } finally {
      setSavingId(null);
    }
  };

  const plan = planId ? plans.find((p) => p.id === planId) : null;

  const loadTakeoffs = (id: string) =>
    listTakeoffs(id)
      .then((rows) => {
        setTakeoffs(rows);
        if (rows.length > 0) {
          listTakeoffTokenUsage(rows.map((r) => r.id))
            .then(setTokenUsage)
            .catch(() => {});
        }
      })
      .catch(() => {});

  useEffect(() => {
    if (!planId) return;
    setLoading(true);
    loadTakeoffs(planId).finally(() => setLoading(false));
  }, [planId]);

  // Watch for an in-progress generation: disable "New takeoffs" and surface a banner,
  // and refresh the list when it finishes.
  useEffect(() => {
    if (!planId) return;
    getActiveTakeoffJob(planId).then(setActiveJob).catch(() => {});
    const unsubscribe = subscribeTakeoffJob(planId, (job) => {
      if (job.status === 'running') {
        setActiveJob(job);
      } else {
        setActiveJob(null);
        if (job.status === 'done') loadTakeoffs(planId);
      }
    });
    return unsubscribe;
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

  const anyFinalized = takeoffs.some((t) => !!t.data.bid?.finalizedAt);
  const sentLocked = takeoffs.some((t) => !!t.data.bid?.sentAt);

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
          {plan ? planDisplayName(plan) : 'Quantity Takeoffs'}
        </h1>
        <button
          type="button"
          disabled={!!activeJob || sentLocked}
          title={sentLocked ? 'This project’s bid has been sent — no new takeoffs can be created.' : undefined}
          onClick={() => navigate(`/projects/${planId}/questionnaire`)}
          className="rounded-lg border-2 border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:border-slate-200"
        >
          New takeoffs
        </button>
      </div>

      {sentLocked && (
        <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" className="shrink-0">
            <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>This project’s bid has been sent to the customer. The project is locked — no new takeoffs can be created.</span>
        </div>
      )}

      {activeJob && (
        <button
          type="button"
          onClick={() => navigate(`/projects/${planId}/questionnaire`)}
          className="mt-5 flex w-full items-center gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left text-sm text-blue-800 transition-colors hover:bg-blue-100"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          <span className="font-medium">Generating takeoff…</span>
          <span className="text-blue-600">View progress →</span>
        </button>
      )}

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
                const isFinalized = !!takeoff.data.bid?.finalizedAt;
                const superseded = anyFinalized && !isFinalized;
                return (
                  <tr
                    key={takeoff.id}
                    onClick={() => navigate(`/projects/${planId}/takeoffs/${takeoff.id}`)}
                    className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3.5 font-medium text-slate-800">
                      {editingId === takeoff.id ? (
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit(takeoff);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            autoFocus
                            className="w-64 rounded border border-slate-300 px-2 py-1 text-sm font-normal focus:border-blue-400 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => saveEdit(takeoff)}
                            disabled={savingId === takeoff.id || !editValue.trim()}
                            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {savingId === takeoff.id ? 'Saving…' : 'Save'}
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
                          <span>{takeoff.data.projectName}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startEdit(takeoff); }}
                            title="Rename takeoff"
                            className="rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                              <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          {isFinalized && (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                              Finalized
                            </span>
                          )}
                          {superseded && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                              Superseded
                            </span>
                          )}
                        </div>
                      )}
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
