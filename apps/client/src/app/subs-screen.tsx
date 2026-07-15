import { useState } from 'react';
import { TRADES } from '@bid-wise/data';
import type { Subcontractor } from '../lib/supabase';
import { createSubcontractor, deleteSubcontractor, updateSubcontractor } from '../lib/supabase';
import { useCompany } from '../lib/company-context';

// ── Subcontractor form modal ──────────────────────────────────────────────────

interface SubFormModalProps {
  initial?: Subcontractor;
  initialTrade?: string;
  onSaved: (sub: Subcontractor) => void;
  onClose: () => void;
}

export function SubcontractorFormModal({ initial, initialTrade, onSaved, onClose }: SubFormModalProps) {
  const { activeCompanyId } = useCompany();
  const [name, setName] = useState(initial?.name ?? '');
  const [selectedTrades, setSelectedTrades] = useState<Set<string>>(
    new Set(initial?.trades ?? (initialTrade ? [initialTrade] : [])),
  );
  const [email, setEmail] = useState(initial?.contactEmail ?? '');
  const [phone, setPhone] = useState(initial?.contactPhone ?? '');
  const [address, setAddress] = useState(initial?.contactAddress ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTrade = (trade: string) =>
    setSelectedTrades((prev) => {
      const choice = TRADES.find((t) => t.label === trade);
      if (choice?.specialAction?.type === 'select-all') {
        if (prev.has(trade)) return new Set();
        const excluded = new Set(choice.specialAction.except ?? []);
        return new Set(
          TRADES.filter((t) => !excluded.has(t.value)).map((t) => t.label),
        );
      }
      const next = new Set(prev);
      next.has(trade) ? next.delete(trade) : next.add(trade);
      return next;
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!initial && !activeCompanyId) { setError('No active company.'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        trades: Array.from(selectedTrades),
        contactEmail: email.trim() || undefined,
        contactPhone: phone.trim() || undefined,
        contactAddress: address.trim() || undefined,
      };
      const saved = initial
        ? await updateSubcontractor(initial.id, payload)
        : await createSubcontractor(activeCompanyId!, payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">
          {initial ? 'Edit sub-contractor' : 'Add sub-contractor'}
        </h2>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-600">Company / name <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
              placeholder="e.g. Smith Plumbing Co."
            />
          </div>

          {/* Trades */}
          <div>
            <label className="block text-xs font-medium text-slate-600">Trades</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {TRADES.map(({ value, label }) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    selectedTrades.has(label)
                      ? 'border-blue-300 bg-blue-50 text-blue-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedTrades.has(label)}
                    onChange={() => toggleTrade(label)}
                    className="accent-blue-600"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Contact info */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
                placeholder="email@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
                placeholder="(555) 555-5555"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Address</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
              placeholder="123 Main St, City, ST 00000"
            />
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Subs screen ───────────────────────────────────────────────────────────────

interface SubsScreenProps {
  subcontractors: Subcontractor[];
  onChanged: (subs: Subcontractor[]) => void;
}

export function SubsScreen({ subcontractors, onChanged }: SubsScreenProps) {
  const [formTarget, setFormTarget] = useState<Subcontractor | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleSaved = (saved: Subcontractor) => {
    onChanged(
      formTarget === 'new'
        ? [...subcontractors, saved].sort((a, b) => a.name.localeCompare(b.name))
        : subcontractors.map((s) => (s.id === saved.id ? saved : s)),
    );
    setFormTarget(null);
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await deleteSubcontractor(id);
      onChanged(subcontractors.filter((s) => s.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="mt-10 w-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Sub-contractors</h2>
        <button
          type="button"
          onClick={() => setFormTarget('new')}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add sub-contractor
        </button>
      </div>

      {subcontractors.length === 0 ? (
        <div className="mt-12 flex flex-col items-center text-center">
          <p className="text-sm text-slate-500">No sub-contractors yet. Add one to get started.</p>
        </div>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Trades</th>
              <th className="pb-2 font-medium">Email</th>
              <th className="pb-2 font-medium">Phone</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {subcontractors.map((sub) => (
              <tr key={sub.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium text-slate-800">{sub.name}</td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {sub.trades.map((t) => (
                      <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t}</span>
                    ))}
                    {sub.trades.length === 0 && <span className="text-slate-400">—</span>}
                  </div>
                </td>
                <td className="py-3 pr-4 text-slate-600">{sub.contactEmail ?? '—'}</td>
                <td className="py-3 pr-4 text-slate-600">{sub.contactPhone ?? '—'}</td>
                <td className="py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setFormTarget(sub)}
                      className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(sub.id)}
                      disabled={deleting === sub.id}
                      className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    >
                      {deleting === sub.id ? '…' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {formTarget !== null && (
        <SubcontractorFormModal
          initial={formTarget === 'new' ? undefined : formTarget}
          onSaved={handleSaved}
          onClose={() => setFormTarget(null)}
        />
      )}
    </div>
  );
}
