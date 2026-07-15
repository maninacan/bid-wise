import { useState } from 'react';
import type { UserSettings } from '../lib/supabase';
import { saveSettings } from '../lib/supabase';
import { useCompany } from '../lib/company-context';
import { TradesSelectorGrid } from './settings-panel';

interface TradesOnboardingModalProps {
  settings: UserSettings;
  onSaved: (settings: UserSettings) => void;
}

export function TradesOnboardingModal({ settings, onSaved }: TradesOnboardingModalProps) {
  const { activeCompanyId } = useCompany();
  const [selected, setSelected] = useState<Set<string>>(new Set(settings.trades));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: Set<string>) => setSelected(next);

  const handleSave = async () => {
    if (!activeCompanyId) return;
    setSaving(true);
    setError(null);
    try {
      const updated: UserSettings = { ...settings, trades: [...selected] };
      await saveSettings(activeCompanyId, updated);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">What trades do you work in?</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Select the trades you handle. These will be included in your bids by default — you can always adjust them later in Settings.
        </p>

        <div className="mt-5">
          <TradesSelectorGrid selected={selected} onChange={toggle} />
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || selected.size === 0}
            className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {saving ? 'Saving…' : selected.size === 0 ? 'Select at least one trade' : 'Get started'}
          </button>
        </div>
      </div>
    </div>
  );
}
