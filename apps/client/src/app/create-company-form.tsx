import { useState } from 'react';
import { createCompany, type Company } from '../lib/supabase';

interface CreateCompanyFormProps {
  onCreated: (company: Company) => void | Promise<void>;
}

/** Name input + submit button for creating a company. No outer card/heading — callers keep
 *  their own framing/copy, since the onboarding gate and the companies page want different
 *  surrounding text. */
export function CreateCompanyForm({ onCreated }: CreateCompanyFormProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const company = await createCompany(name.trim());
      await onCreated(company);
      setName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create company.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Smith Construction"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>
      {createError && <p className="mt-3 text-xs text-red-600">{createError}</p>}
    </>
  );
}
