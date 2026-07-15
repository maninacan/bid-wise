import { useState } from 'react';
import { TRADES } from '@bid-wise/data';
import type { BidSharingMode, UserSettings } from '../lib/supabase';
import { saveSettings } from '../lib/supabase';
import { useCompany } from '../lib/company-context';

interface TradesSelectorGridProps {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

export function TradesSelectorGrid({ selected, onChange }: TradesSelectorGridProps) {
  const handleChange = (value: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) {
      next.add(value);
      if (value === 'gc') TRADES.forEach((t) => next.add(t.value));
    } else {
      next.delete(value);
      if (value === 'gc') next.clear();
    }
    onChange(next);
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {TRADES.map((trade) => (
        <label
          key={trade.value}
          className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 text-sm transition-colors hover:bg-slate-50 has-[:checked]:border-blue-300 has-[:checked]:bg-blue-50"
        >
          <input
            type="checkbox"
            checked={selected.has(trade.value)}
            onChange={(e) => handleChange(trade.value, e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-blue-600"
          />
          <span className="text-slate-700">{trade.label}</span>
        </label>
      ))}
    </div>
  );
}

interface SettingsPanelProps {
  settings: UserSettings;
  onClose: () => void;
  onSaved: (settings: UserSettings) => void;
}

type SettingsTab = 'trades' | 'sharing';

export function SettingsPanel({ settings, onClose, onSaved }: SettingsPanelProps) {
  const { activeCompanyId } = useCompany();
  const [activeTab, setActiveTab] = useState<SettingsTab>('trades');
  const [selectedTrades, setSelectedTrades] = useState<Set<string>>(
    new Set(settings.trades),
  );
  const [bidSharingMode, setBidSharingMode] = useState<BidSharingMode>(
    settings.bidSharingMode,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const toggleTrade = (next: Set<string>) => setSelectedTrades(next);

  const handleSave = async () => {
    if (!activeCompanyId) { setSaveError('No active company.'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const updatedSettings: UserSettings = {
        pricingMatrix: settings.pricingMatrix,
        trades: [...selectedTrades],
        dismissedNotices: settings.dismissedNotices,
        bidSharingMode,
      };
      await saveSettings(activeCompanyId, updatedSettings);
      setSavedAt(new Date());
      onSaved(updatedSettings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-[calc(100%-3rem)] flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-8 py-4">
          <h2 className="text-base font-semibold text-slate-900">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-slate-200 px-8">
          {(['trades', 'sharing'] as SettingsTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-4 py-3 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {activeTab === 'trades' && (
            <section>
              <h3 className="text-sm font-semibold text-slate-800">Your trades</h3>
              <p className="mt-1 text-xs text-slate-500">
                Select the trades you handle. If you're a general contractor, you'll likely want most or all of these — they'll be included in your bids by default. You can adjust the scope on any individual bid, and delegate specific trades to subcontractors at any time.
              </p>
              <div className="mt-3">
                <TradesSelectorGrid selected={selectedTrades} onChange={toggleTrade} />
              </div>
            </section>
          )}

          {activeTab === 'sharing' && (
            <section>
              <h3 className="text-sm font-semibold text-slate-800">Bid sharing</h3>
              <p className="mt-1 text-xs text-slate-500">
                Control how much detail is included when you share a finalized bid as a PDF.
              </p>
              <div className="mt-4 space-y-3">
                {([
                  {
                    value: 'full' as BidSharingMode,
                    label: 'Full bid',
                    description: 'Every line item is listed with its final unit price and total. No distinction is made between AI-sourced prices and manual overrides — recipients see only the effective price.',
                  },
                  {
                    value: 'summary' as BidSharingMode,
                    label: 'Trade summary only',
                    description: 'Only the subtotal per trade category is shown, along with the overall markup breakdown and final total. Individual line items are not included.',
                  },
                ] as { value: BidSharingMode; label: string; description: string }[]).map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
                      bidSharingMode === option.value
                        ? 'border-blue-300 bg-blue-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="bidSharingMode"
                      value={option.value}
                      checked={bidSharingMode === option.value}
                      onChange={() => setBidSharingMode(option.value)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{option.label}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{option.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-slate-200 px-8 py-4">
          {saveError && <span className="text-xs text-red-600">{saveError}</span>}
          {savedAt && !saveError && (
            <span className="text-xs text-slate-400">
              Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
