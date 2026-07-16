import { useState } from 'react';
import { renameCompany } from '../lib/supabase';
import { useCompany } from '../lib/company-context';
import { PendingInvitesList } from './pending-invites-list';
import { CreateCompanyForm } from './create-company-form';

export function CompaniesScreen() {
  const { companies, activeCompanyId, setActiveCompanyId, refresh } = useCompany();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const startEdit = (companyId: string, currentName: string) => {
    setEditingId(companyId);
    setEditName(currentName);
    setRenameError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setRenameError(null);
  };

  const handleSave = async (companyId: string) => {
    if (!editName.trim()) { setRenameError('Name is required.'); return; }
    setSaving(true);
    setRenameError(null);
    try {
      await renameCompany(companyId, editName.trim());
      await refresh();
      setEditingId(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Could not rename company.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-10 w-full max-w-2xl">
      <h2 className="text-lg font-semibold text-slate-900">Companies</h2>
      <p className="mt-1 text-sm text-slate-500">
        Switch between companies you belong to, or create a new one.
      </p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Role</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {companies.map((m) => {
            const isEditing = editingId === m.company.id;
            return (
              <tr key={m.company.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium text-slate-800">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      className="w-full rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span>{m.company.name}</span>
                      <button
                        type="button"
                        onClick={() => startEdit(m.company.id, m.company.name)}
                        aria-label={`Rename ${m.company.name}`}
                        className="text-slate-400 hover:text-slate-600"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                        </svg>
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-3 pr-4 capitalize text-slate-600">{m.role}</td>
                <td className="py-3 text-right">
                  {isEditing ? (
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={saving}
                        className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSave(m.company.id)}
                        disabled={saving}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ) : m.company.id === activeCompanyId ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      Current
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveCompanyId(m.company.id)}
                      className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    >
                      Switch
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {renameError && <p className="mt-2 text-xs text-red-600">{renameError}</p>}

      <div className="mt-8 empty:hidden">
        <PendingInvitesList onAccepted={(company) => refresh(company.id)} />
      </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800">Create a company</h3>
        <p className="mt-1 text-xs text-slate-500">
          Running more than one business? Create another company — it gets its own projects,
          subs, and billing.
        </p>
        <div className="mt-4">
          <CreateCompanyForm onCreated={(company) => refresh(company.id)} />
        </div>
      </div>
    </div>
  );
}
