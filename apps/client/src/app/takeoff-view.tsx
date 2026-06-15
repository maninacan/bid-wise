import { createContext, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Tooltip } from '@bid-wise/common-components';
import type {
  BidData,
  BidSharingMode,
  DelegationData,
  PricingMatrix,
  Subcontractor,
  Takeoff,
  TakeoffData,
  TakeoffGap,
  TakeoffItem,
  TakeoffSection,
} from '../lib/supabase';
import { approveSubBid, clarifyTakeoff, finalizeBid, getLocalPricing, saveBid, saveMaterialsList, saveMaterialsOverrides, saveSubPrices, shareBidPdf, unfinalizeBid } from '../lib/supabase';
import { SubcontractorFormModal } from './subs-screen';

/** Normalize legacy string gaps from old takeoffs to the structured format. */
function normalizeGap(g: TakeoffGap | string): TakeoffGap {
  return typeof g === 'string' ? { trade: 'General', description: g } : g;
}

const sourceBadgeStyles: Record<string, string> = {
  stated: 'bg-green-100 text-green-800',
  derived: 'bg-blue-100 text-blue-800',
  estimated: 'bg-amber-100 text-amber-800',
};

/** Spelled-out names for the bid unit abbreviations (see generate-takeoff). */
const UNIT_LABELS: Record<string, string> = {
  SF: 'Square feet',
  SQ: 'Squares (100 sq ft of roofing)',
  LF: 'Linear feet',
  SY: 'Square yards',
  CY: 'Cubic yards',
  CF: 'Cubic feet',
  EA: 'Each',
  LS: 'Lump sum',
  TON: 'Tons',
  GAL: 'Gallons',
  BF: 'Board feet',
  PR: 'Pairs',
  HR: 'Hours',
};

/** Abbreviation → meaning lookup for the current takeoff. Seeded with the canonical
 *  units and augmented with the AI-generated acronyms from the takeoff itself. Keys are
 *  uppercased. Provided by TakeoffView so any nested panel can resolve a tooltip. */
const AcronymContext = createContext<Record<string, string>>(UNIT_LABELS);

/** A unit abbreviation that spells itself out in a tooltip on hover. */
function Unit({ value }: { value: string }) {
  const acronyms = useContext(AcronymContext);
  const label = acronyms[value?.toUpperCase()];
  if (!label) return <>{value}</>;
  return (
    <Tooltip content={label} className="cursor-help">
      {value}
    </Tooltip>
  );
}

/** Renders free text (a description or note), wrapping any token that is a known
 *  acronym in a tooltip spelling it out. Only fully-uppercase tokens match, so plain
 *  words are never wrapped. */
function AcronymText({ text }: { text?: string }) {
  const acronyms = useContext(AcronymContext);
  if (!text) return null;
  // Split on word boundaries, keeping the words and the separators between them.
  const parts = text.split(/([A-Za-z0-9]+)/);
  return (
    <>
      {parts.map((part, i) => {
        const meaning = acronyms[part.toUpperCase()];
        const isAcronym = !!meaning && /[A-Z]/.test(part) && part === part.toUpperCase();
        return isAcronym ? (
          <Tooltip
            key={i}
            content={meaning}
            className="cursor-help underline decoration-dotted decoration-slate-300 underline-offset-2"
          >
            {part}
          </Tooltip>
        ) : (
          part
        );
      })}
    </>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

type Tab = 'takeoff' | 'materials' | 'pricing' | 'bids';

// ── Update button ─────────────────────────────────────────────────────────────

interface UpdateButtonProps {
  count: number;
  loading: boolean;
  error: string | null;
  onClick: () => void;
}

function UpdateButton({ count, loading, error, onClick }: UpdateButtonProps) {
  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
      >
        {loading ? 'Updating…' : `Update (${count} pending)`}
      </button>
    </div>
  );
}

// ── Materials selection modal ─────────────────────────────────────────────────

interface MaterialsModalProps {
  trades: string[];
  initialSelected: string[];
  onGenerate: (selected: string[]) => void;
  onClose: () => void;
}

function MaterialsModal({
  trades,
  initialSelected,
  onGenerate,
  onClose,
}: MaterialsModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialSelected.length > 0 ? initialSelected : trades),
  );

  const toggle = (trade: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(trade) ? next.delete(trade) : next.add(trade);
      return next;
    });

  const toggleAll = () =>
    setSelected(selected.size === trades.length ? new Set() : new Set(trades));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">
          Configure Materials List
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Select the trade categories to include.
        </p>
        <button
          type="button"
          onClick={toggleAll}
          className="mt-4 text-xs font-medium text-blue-600 hover:text-blue-500"
        >
          {selected.size === trades.length ? 'Deselect all' : 'Select all'}
        </button>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {trades.map((trade) => (
            <label
              key={trade}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 text-sm transition-colors hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.has(trade)}
                onChange={() => toggle(trade)}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              <span className="text-slate-700">{trade}</span>
            </label>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onGenerate([...selected])}
            disabled={selected.size === 0}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Verify modal ──────────────────────────────────────────────────────────────

interface VerifyModalProps {
  gap: string;
  initialValue: string;
  onSave: (clarification: string) => void;
  onClose: () => void;
}

function VerifyModal({ gap, initialValue, onSave, onClose }: VerifyModalProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">
          Provide Missing Information
        </h2>
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {gap}
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter the actual value or specification…"
          rows={3}
          autoFocus
          className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (value.trim()) onSave(value.trim());
            }}
            disabled={!value.trim()}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Unverified items warning ──────────────────────────────────────────────────

function UnverifiedWarning({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
      <p className="text-sm text-amber-800">
        <span className="font-semibold">{count} item{count !== 1 ? 's' : ''} still need{count === 1 ? 's' : ''} verification.</span>
        {' '}Your quantity calculations may be off until {count === 1 ? 'it is' : 'they are'} resolved.
      </p>
    </div>
  );
}

// ── Takeoff tab panel ─────────────────────────────────────────────────────────

interface TakeoffPanelProps {
  data: TakeoffData;
  pending: Map<string, string>;
  onVerify: (gap: string) => void;
  readOnly?: boolean;
}

function TakeoffPanel({ data, pending, onVerify, readOnly = false }: TakeoffPanelProps) {
  const gaps = data.gaps.map(normalizeGap);
  const unverifiedCount = gaps.filter((gap) => !pending.has(gap.description)).length;
  return (
    <div className="mt-5">
      <UnverifiedWarning count={unverifiedCount} />
      <p className="mt-4 text-sm text-slate-600">{data.summary}</p>

      {data.areas.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {data.areas.map((area) => (
            <span
              key={area.name}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
            >
              {area.name}: {area.squareFeet.toLocaleString()} SF
            </span>
          ))}
        </div>
      )}

      {data.sections.map((section, i) => (
        <div key={`${section.trade}-${i}`} className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {section.trade}
          </h3>
          <table className="mt-2 w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="py-1.5 pr-2 font-medium">Item</th>
                <th className="w-20 py-1.5 pr-2 text-right font-medium">Qty</th>
                <th className="w-16 py-1.5 pr-2 font-medium">Unit</th>
                <th className="w-24 py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {section.items.map((item, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="py-1.5 pr-2 text-slate-700">
                    <AcronymText text={item.description} />
                    {item.notes && (
                      <span className="block text-xs text-slate-400">
                        <AcronymText text={item.notes} />
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                    {item.quantity.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-2 text-slate-500"><Unit value={item.unit} /></td>
                  <td className="py-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        sourceBadgeStyles[item.source] ??
                        'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {item.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {gaps.length > 0 && (
        <div className="mt-6 rounded-lg bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-800">
            Verify before bidding
          </h3>
          <ul className="mt-2 space-y-1.5 pl-5 text-sm text-amber-700">
            {gaps.map((gap) => {
              const savedValue = pending.get(gap.description);
              return (
                <li key={`${gap.trade}::${gap.description}`} className="list-disc">
                  <span className="mr-1.5 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                    {gap.trade}
                  </span>
                  {gap.description}
                  {!readOnly && (savedValue ? (
                    <>
                      <span className="ml-2 italic text-blue-700">
                        "{savedValue}"
                      </span>
                      <button
                        type="button"
                        onClick={() => onVerify(gap.description)}
                        className="ml-2 text-xs font-medium text-blue-600 underline hover:text-blue-500"
                      >
                        edit
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onVerify(gap.description)}
                      className="ml-2 text-xs font-medium text-blue-600 underline hover:text-blue-500"
                    >
                      verify
                    </button>
                  ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Materials tab panel ───────────────────────────────────────────────────────

interface MaterialsSection {
  trade: string;
  items: TakeoffItem[];
}

function itemGap(item: TakeoffItem): string {
  return item.notes ? item.description + ' — ' + item.notes : item.description;
}

interface MaterialsPanelProps {
  takeoffId: string;
  sections: MaterialsSection[] | null;
  initialOverrides?: Record<string, number>;
  pending: Map<string, string>;
  updating: boolean;
  updateError: string | null;
  onVerify: (gap: string) => void;
  onUpdate: () => void;
  onConfigure: () => void;
  onOverridesSaved: (overrides: Record<string, number>) => void;
  readOnly?: boolean;
}

function MaterialsPanel({
  takeoffId,
  sections,
  initialOverrides = {},
  pending,
  updating,
  updateError,
  onVerify,
  onUpdate,
  onConfigure,
  onOverridesSaved,
  readOnly = false,
}: MaterialsPanelProps) {
  const [overrides, setOverrides] = useState<Record<string, number>>(initialOverrides);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const handleSaveOverrides = async () => {
    setSaving(true);
    try {
      await saveMaterialsOverrides(takeoffId, overrides);
      setSavedAt(new Date());
      onOverridesSaved(overrides);
    } finally {
      setSaving(false);
    }
  };

  const matKey = (trade: string, description: string) => `${trade}::${description}`;
  if (!sections) {
    return (
      <div className="flex flex-col items-center py-14 text-center">
        <p className="text-sm text-slate-500">
          No materials list generated yet.
        </p>
        <button
          type="button"
          onClick={onConfigure}
          className="mt-4 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500"
        >
          Generate materials list
        </button>
      </div>
    );
  }

  const unverifiedCount = sections
    ? sections.reduce(
        (sum, s) =>
          sum +
          s.items.filter(
            (item) => item.source === 'estimated' && !pending.has(itemGap(item)),
          ).length,
        0,
      )
    : 0;

  return (
    <div className="mt-4">
      {unverifiedCount > 0 && (
        <div className="mb-4">
          <UnverifiedWarning count={unverifiedCount} />
        </div>
      )}
      <div className="flex items-center justify-between">
        {!readOnly && (
          <button
            type="button"
            onClick={onConfigure}
            className="text-xs font-medium text-slate-400 hover:text-slate-600"
          >
            Edit categories
          </button>
        )}
        {readOnly && <span />}
        {pending.size > 0 && (
          <UpdateButton
            count={pending.size}
            loading={updating}
            error={updateError}
            onClick={onUpdate}
          />
        )}
      </div>

      {sections.map((section, i) => (
        <div key={`${section.trade}-${i}`} className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {section.trade}
          </h4>
          <table className="mt-1.5 w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="py-1.5 pr-2 font-medium">Material</th>
                <th className="w-20 py-1.5 pr-2 text-right font-medium">Qty</th>
                <th className="w-28 py-1.5 pr-2 text-right font-medium">Qty override</th>
                <th className="w-16 py-1.5 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody>
              {section.items.map((item, i) => {
                const gap = itemGap(item);
                const savedValue =
                  item.source === 'estimated' ? pending.get(gap) : undefined;
                const key = matKey(section.trade, item.description);
                const override = overrides[key];
                return (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-1.5 pr-2 text-slate-700">
                      <AcronymText text={item.description} />
                      {(item.notes || item.source === 'estimated') && (
                        <span className="block text-xs text-slate-400">
                          <AcronymText text={item.notes} />
                          {item.source === 'estimated' && !readOnly && (
                            <>
                              {item.notes ? ' · ' : ''}
                              {savedValue ? (
                                <>
                                  <span className="italic text-blue-600">
                                    "{savedValue}"
                                  </span>
                                  {' · '}
                                  <button
                                    type="button"
                                    onClick={() => onVerify(gap)}
                                    className="font-medium text-blue-600 underline hover:text-blue-500"
                                  >
                                    edit
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onVerify(gap)}
                                  className="font-medium text-blue-600 underline hover:text-blue-500"
                                >
                                  verify
                                </button>
                              )}
                            </>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                      {override != null ? (
                        <span className="text-slate-400 line-through">{item.quantity.toLocaleString()}</span>
                      ) : (
                        item.quantity.toLocaleString()
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {readOnly ? (
                        <span className="text-sm tabular-nums text-slate-500">
                          {override != null ? override.toLocaleString() : '—'}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={override ?? ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setOverrides((prev) => {
                              const next = { ...prev };
                              if (val === '') delete next[key];
                              else next[key] = parseFloat(val);
                              return next;
                            });
                            setSavedAt(null);
                          }}
                          placeholder="—"
                          className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:border-blue-400 focus:outline-none"
                        />
                      )}
                    </td>
                    <td className="py-1.5 text-slate-500"><Unit value={item.unit} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {!readOnly && (
        <div className="mt-6 flex items-center justify-end gap-3">
          {savedAt && (
            <span className="text-xs text-slate-400">
              Saved {format(savedAt, 'h:mm a')}
            </span>
          )}
          <button
            type="button"
            onClick={handleSaveOverrides}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
          >
            {saving ? 'Saving…' : 'Save overrides'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const bidKey = (trade: string, description: string) => `${trade}::${description}`;

// ── Delegate modal ────────────────────────────────────────────────────────────

interface DelegateModalProps {
  trade: string;
  subcontractors: Subcontractor[];
  currentSubId?: string;
  onSelect: (subId: string) => void;
  onUnassign: () => void;
  onAddNew: () => void;
  onClose: () => void;
}

function DelegateModal({
  trade,
  subcontractors,
  currentSubId,
  onSelect,
  onUnassign,
  onAddNew,
  onClose,
}: DelegateModalProps) {
  const tradeLower = trade.toLowerCase();
  const matching = subcontractors.filter((s) =>
    s.trades.some((t) => {
      const tl = t.toLowerCase();
      return tl === tradeLower || tl.includes(tradeLower) || tradeLower.includes(tl);
    }),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Delegate — {trade}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {matching.length === 0 ? (
            <p className="text-sm text-slate-500">No {trade} sub-contractors yet.</p>
          ) : (
            matching.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => onSelect(sub.id)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                  sub.id === currentSubId
                    ? 'border-blue-300 bg-blue-50'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <p className="text-sm font-medium text-slate-800">{sub.name}</p>
                {(sub.contactEmail || sub.contactPhone) && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    {[sub.contactEmail, sub.contactPhone].filter(Boolean).join(' · ')}
                  </p>
                )}
              </button>
            ))
          )}

          {currentSubId && (
            <button
              type="button"
              onClick={onUnassign}
              className="w-full rounded-lg border border-slate-200 px-4 py-2.5 text-left text-sm text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            >
              Remove delegation
            </button>
          )}

          <button
            type="button"
            onClick={onAddNew}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add a sub-contractor
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pricing tab panel ─────────────────────────────────────────────────────────

interface PricingPanelProps {
  takeoffId: string;
  sections: TakeoffSection[];
  initialBid?: BidData;
  subcontractors: Subcontractor[];
  onSubcontractorAdded: (sub: Subcontractor) => void;
  onSaved: (data: TakeoffData) => void;
  readOnly?: boolean;
}

function PricingPanel({ takeoffId, sections, initialBid, subcontractors, onSubcontractorAdded, onSaved, readOnly = false }: PricingPanelProps) {
  const [aiPrices, setAiPrices] = useState<Record<string, number>>(
    initialBid?.aiPrices ?? {},
  );

  const [manualPrices, setManualPrices] = useState<Record<string, string>>(() => {
    const savedAi = initialBid?.aiPrices ?? {};
    return Object.fromEntries(
      Object.entries(initialBid?.prices ?? {})
        .filter(([k, v]) => {
          const ai = savedAi[k];
          return ai === undefined || v !== ai;
        })
        .map(([k, v]) => [k, String(v)]),
    );
  });

  const [aiPricesUpdatedAt, setAiPricesUpdatedAt] = useState<Date | null>(
    initialBid?.aiPricesUpdatedAt ? new Date(initialBid.aiPricesUpdatedAt) : null,
  );
  const [aiPricesZipCode, setAiPricesZipCode] = useState<string | null>(
    initialBid?.aiPricesZipCode ?? null,
  );

  const [zipPromptOpen, setZipPromptOpen] = useState(false);
  const [zipCode, setZipCode] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFilled, setAiFilled] = useState<number | null>(null);
  const [delegations, setDelegations] = useState<Record<string, DelegationData>>(
    initialBid?.delegations ?? {},
  );
  const [delegateModalTrade, setDelegateModalTrade] = useState<string | null>(null);
  const [addSubForTrade, setAddSubForTrade] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const effectiveUnitPrice = (key: string, trade?: string): number => {
    if (trade && delegations[trade]) return delegations[trade].prices[key] ?? 0;
    const manual = manualPrices[key];
    if (manual && parseFloat(manual) > 0) return parseFloat(manual);
    return aiPrices[key] ?? 0;
  };

  const handleAiPricing = async () => {
    if (!zipCode.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiFilled(null);

    const seen = new Set<string>();
    const lineItems: { trade: string; description: string; unit: string }[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        const key = bidKey(section.trade, item.description);
        if (!seen.has(key)) {
          seen.add(key);
          lineItems.push({ trade: section.trade, description: item.description, unit: item.unit });
        }
      }
    }

    try {
      const prices = await getLocalPricing(zipCode.trim(), lineItems, takeoffId);
      const now = new Date();
      const zip = zipCode.trim();
      setAiPrices(prices);
      setAiPricesUpdatedAt(now);
      setAiPricesZipCode(zip);
      setAiFilled(Object.keys(prices).length);
      setZipPromptOpen(false);

      // Auto-save AI prices immediately. Use only actual manual overrides for `prices`
      // (not initialBid.prices, which may contain stale AI prices from a prior save).
      const manualOnly = Object.fromEntries(
        Object.entries(manualPrices)
          .map(([k, v]) => [k, parseFloat(v)])
          .filter(([, v]) => (v as number) > 0),
      ) as Record<string, number>;
      const savedData = await saveBid(takeoffId, {
        prices: manualOnly,
        aiPrices: prices,
        aiPricesUpdatedAt: now.toISOString(),
        aiPricesZipCode: zip,
        delegations: initialBid?.delegations,
        overheadPct: initialBid?.overheadPct ?? 10,
        profitPct: initialBid?.profitPct ?? 10,
        contingencyPct: initialBid?.contingencyPct ?? 5,
      });
      onSaved(savedData);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Pricing request failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const prices: Record<string, number> = {};
      for (const section of sections) {
        const del = delegations[section.trade];
        for (const item of section.items) {
          const key = bidKey(section.trade, item.description);
          const p = del ? (del.prices[key] ?? 0) : effectiveUnitPrice(key);
          if (p > 0) prices[key] = p;
        }
      }
      const saved = await saveBid(takeoffId, {
        prices,
        aiPrices: Object.keys(aiPrices).length > 0 ? aiPrices : undefined,
        aiPricesUpdatedAt: aiPricesUpdatedAt?.toISOString(),
        aiPricesZipCode: aiPricesZipCode ?? undefined,
        delegations: Object.keys(delegations).length > 0 ? delegations : undefined,
        overheadPct: initialBid?.overheadPct ?? 10,
        profitPct: initialBid?.profitPct ?? 10,
        contingencyPct: initialBid?.contingencyPct ?? 5,
      });
      onSaved(saved);
      setSavedAt(new Date());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4">
      {/* AI pricing */}
      {!readOnly && <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setZipPromptOpen((o) => !o); setAiError(null); }}
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 hover:border-blue-300"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2Z" />
              <path d="M19 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" />
              <path d="M4 15l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8Z" />
            </svg>
            Get AI pricing by zip code
          </button>
          <button
            type="button"
            onClick={() => setManualPrices({})}
            disabled={Object.keys(manualPrices).length === 0}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear overrides
          </button>
          {aiFilled !== null && (
            <span className="text-xs text-green-700">
              ✓ Filled {aiFilled} price{aiFilled !== 1 ? 's' : ''}
            </span>
          )}
          {aiPricesUpdatedAt && aiFilled === null && (
            <span className="text-xs text-slate-400">
              AI prices last updated {format(aiPricesUpdatedAt, 'MMM d, yyyy')}{aiPricesZipCode && ` · ${aiPricesZipCode}`}
            </span>
          )}
        </div>
        {zipPromptOpen && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3">
            <label className="shrink-0 text-sm text-slate-600">ZIP code</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAiPricing()}
              placeholder="e.g. 90210"
              autoFocus
              className="w-32 rounded border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAiPricing}
              disabled={aiLoading || !zipCode.trim()}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {aiLoading ? 'Fetching…' : 'Get pricing'}
            </button>
            {aiLoading && (
              <span className="text-xs text-slate-400">This may take 15–30 seconds…</span>
            )}
            {aiError && <span className="text-xs text-red-600">{aiError}</span>}
          </div>
        )}
      </div>}

      {/* Line items by trade */}
      {sections.map((section, i) => {
        const del = delegations[section.trade];
        const delegatedSub = del ? subcontractors.find((s) => s.id === del.subId) : null;
        const sectionTotal = section.items.reduce(
          (sum, item) => sum + item.quantity * effectiveUnitPrice(bidKey(section.trade, item.description), section.trade),
          0,
        );
        return (
          <div key={`${section.trade}-${i}`} className="mt-5">
            {/* Section header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-1">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {section.trade}
                </h4>
                {del ? (
                  readOnly ? (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                      {delegatedSub?.name ?? 'Delegated'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDelegateModalTrade(section.trade)}
                      className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 transition-colors hover:bg-violet-200"
                    >
                      {delegatedSub?.name ?? 'Delegated'}
                    </button>
                  )
                ) : !readOnly && (
                  <button
                    type="button"
                    onClick={() => setDelegateModalTrade(section.trade)}
                    className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-600"
                  >
                    Delegate to Sub-contractor
                  </button>
                )}
              </div>
              {sectionTotal > 0 && (
                <span className="text-xs tabular-nums text-slate-400">{fmt(sectionTotal)}</span>
              )}
            </div>

            {del ? (
              /* Delegated: only show items once the sub has approved their bid */
              !del.approvedAt ? (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  {delegatedSub?.name ?? 'The subcontractor'} has not yet approved their bid.
                </div>
              ) : (
                <table className="mt-1.5 w-full table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                      <th className="py-1.5 pr-3 font-medium">Item</th>
                      <th className="w-16 py-1.5 pr-3 text-right font-medium">Qty</th>
                      <th className="w-16 py-1.5 pr-3 font-medium">Unit</th>
                      <th className="w-28 py-1.5 pr-3 text-right font-medium">Sub quote</th>
                      <th className="w-24 py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.items.filter((item) => del.prices[bidKey(section.trade, item.description)] != null).map((item, i) => {
                      const key = bidKey(section.trade, item.description);
                      const subPrice = del.prices[key];
                      const lineTotal = item.quantity * (subPrice ?? 0);
                      return (
                        <tr key={i} className="border-b border-slate-50 align-middle">
                          <td className="py-1.5 pr-3 text-slate-700">
                            <AcronymText text={item.description} />
                            {item.notes && (
                              <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                            {item.quantity.toLocaleString()}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-500"><Unit value={item.unit} /></td>
                          <td className="py-1 pr-3">
                            <div className="flex items-center justify-end gap-0.5">
                              <span className="text-xs text-slate-400">$</span>
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={subPrice != null ? String(subPrice) : ''}
                                onChange={(e) => {
                                  if (readOnly) return;
                                  const val = parseFloat(e.target.value) || 0;
                                  setDelegations((prev) => ({
                                    ...prev,
                                    [section.trade]: {
                                      ...prev[section.trade],
                                      prices: { ...prev[section.trade].prices, [key]: val },
                                    },
                                  }));
                                }}
                                readOnly={readOnly}
                                placeholder="0"
                                className="w-24 rounded border border-violet-200 bg-violet-50/40 px-2 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none disabled:opacity-60"
                              />
                            </div>
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-slate-700">
                            {lineTotal > 0 ? fmt(lineTotal) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
            ) : (
              /* Non-delegated: AI price + override table */
              <table className="mt-1.5 w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                    <th className="py-1.5 pr-3 font-medium">Item</th>
                    <th className="w-16 py-1.5 pr-3 text-right font-medium">Qty</th>
                    <th className="w-16 py-1.5 pr-3 font-medium">Unit</th>
                    <th className="w-24 py-1.5 pr-3 text-right font-medium">AI price</th>
                    <th className="w-28 py-1.5 pr-3 text-right font-medium">Override</th>
                    <th className="w-24 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, i) => {
                    const key = bidKey(section.trade, item.description);
                    const aiPrice = aiPrices[key];
                    const manualVal = manualPrices[key] ?? '';
                    const lineTotal = item.quantity * effectiveUnitPrice(key);
                    return (
                      <tr key={i} className="border-b border-slate-50 align-middle">
                        <td className="py-1.5 pr-3 text-slate-700">
                          <AcronymText text={item.description} />
                          {item.notes && (
                            <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                          {item.quantity.toLocaleString()}
                        </td>
                        <td className="py-1.5 pr-3 text-slate-500"><Unit value={item.unit} /></td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-400">
                          {aiPrice != null ? fmt(aiPrice) : '—'}
                        </td>
                        <td className="py-1 pr-3">
                          <div className="flex items-center justify-end gap-0.5">
                            <span className="text-xs text-slate-400">$</span>
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={manualVal}
                              onChange={(e) => {
                                if (readOnly) return;
                                setManualPrices((prev) => ({ ...prev, [key]: e.target.value }));
                              }}
                              readOnly={readOnly}
                              placeholder={aiPrice != null ? String(aiPrice) : '0'}
                              className="w-24 rounded border border-slate-200 px-2 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:border-blue-400 focus:outline-none disabled:opacity-60"
                            />
                          </div>
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-slate-700">
                          {lineTotal > 0 ? fmt(lineTotal) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {/* Save row */}
      {!readOnly && (
        <div className="mt-6 flex items-center justify-end gap-3">
          {saveError && <span className="text-xs text-red-600">{saveError}</span>}
          {savedAt && !saveError && (
            <span className="text-xs text-slate-400">
              Saved {format(savedAt, 'h:mm a')}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
          >
            {saving ? 'Saving…' : 'Save pricing'}
          </button>
        </div>
      )}

      {/* Delegate modal */}
      {delegateModalTrade && (
        <DelegateModal
          trade={delegateModalTrade}
          subcontractors={subcontractors}
          currentSubId={delegations[delegateModalTrade]?.subId}
          onSelect={(subId) => {
            setDelegations((prev) => {
              const existing = prev[delegateModalTrade];
              const prices = existing?.subId === subId ? (existing.prices ?? {}) : {};
              return { ...prev, [delegateModalTrade]: { subId, prices } };
            });
            setDelegateModalTrade(null);
          }}
          onUnassign={() => {
            setDelegations((prev) => {
              const next = { ...prev };
              delete next[delegateModalTrade];
              return next;
            });
            setDelegateModalTrade(null);
          }}
          onAddNew={() => {
            setAddSubForTrade(delegateModalTrade);
            setDelegateModalTrade(null);
          }}
          onClose={() => setDelegateModalTrade(null)}
        />
      )}

      {/* Add sub-contractor modal (pre-fills the current trade) */}
      {addSubForTrade && (
        <SubcontractorFormModal
          initialTrade={addSubForTrade}
          onSaved={(sub) => {
            onSubcontractorAdded(sub);
            setDelegations((prev) => ({ ...prev, [addSubForTrade]: { subId: sub.id, prices: {} } }));
            setAddSubForTrade(null);
          }}
          onClose={() => setAddSubForTrade(null)}
        />
      )}
    </div>
  );
}

// ── Bids tab panel ────────────────────────────────────────────────────────────

function matrixPriceFor(
  matrix: PricingMatrix,
  trade: string,
  unit: string,
): number | undefined {
  const override = matrix.tradeOverrides.find(
    (o) => o.trade.toLowerCase() === trade.toLowerCase() && o.unit === unit,
  );
  if (override) return override.rate;
  return matrix.unitDefaults[unit];
}

interface BidsPanelProps {
  takeoffId: string;
  sections: TakeoffSection[];
  initialBid?: BidData;
  pricingMatrix: PricingMatrix;
  subcontractors: Subcontractor[];
  onSaved: (data: TakeoffData) => void;
  readOnly?: boolean;
  sharingMode?: BidSharingMode;
}

function BidsPanel({
  takeoffId,
  sections,
  initialBid,
  pricingMatrix,
  subcontractors,
  onSaved,
  readOnly = false,
  sharingMode = 'full',
}: BidsPanelProps) {
  const savedPrices = initialBid?.prices ?? {};
  const aiPrices = initialBid?.aiPrices ?? {};
  const delegations = initialBid?.delegations ?? {};

  const [overheadPct, setOverheadPct] = useState(String(initialBid?.overheadPct ?? 10));
  const [profitPct, setProfitPct] = useState(String(initialBid?.profitPct ?? 10));
  const [contingencyPct, setContingencyPct] = useState(String(initialBid?.contingencyPct ?? 5));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const [finalizeConfirmOpen, setFinalizeConfirmOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [unfinalizing, setUnfinalizing] = useState(false);
  const [unfinalizeError, setUnfinalizeError] = useState<string | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [sharePhone, setSharePhone] = useState('');
  const [shareMode, setShareMode] = useState<BidSharingMode>(sharingMode);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState(false);
  const [excludedTrades, setExcludedTrades] = useState<Set<string>>(
    () => new Set(initialBid?.excludedTrades ?? []),
  );

  const toggleExcluded = (trade: string) =>
    setExcludedTrades((prev) => {
      const next = new Set(prev);
      if (next.has(trade)) next.delete(trade);
      else next.add(trade);
      return next;
    });

  const effectivePrice = (key: string, trade?: string): number => {
    if (trade && delegations[trade]) return delegations[trade].prices[key] ?? 0;
    const saved = savedPrices[key];
    if (saved !== undefined && saved > 0) return saved;
    const matrixRate = (() => {
      for (const s of sections) {
        const item = s.items.find((i) => bidKey(s.trade, i.description) === key);
        if (item) return matrixPriceFor(pricingMatrix, s.trade, item.unit);
      }
      return undefined;
    })();
    return matrixRate ?? 0;
  };

  const priceSource = (key: string, trade?: string): 'ai' | 'override' | 'sub' | null => {
    if (trade && delegations[trade]) {
      const subPrice = delegations[trade].prices[key];
      return subPrice != null && subPrice > 0 ? 'sub' : null;
    }
    const price = savedPrices[key];
    if (price === undefined || price === 0) return null;
    const ai = aiPrices[key];
    if (ai !== undefined && price === ai) return 'ai';
    return 'override';
  };

  const sectionRows = sections.map((s) => {
    const del = delegations[s.trade];
    return {
      trade: s.trade,
      delegation: del,
      items: s.items.map((item) => {
        const key = bidKey(s.trade, item.description);
        const unitPrice = effectivePrice(key, s.trade);
        return { ...item, key, unitPrice, source: priceSource(key, s.trade), lineTotal: item.quantity * unitPrice };
      }),
      get subtotal() {
        return this.items.reduce((sum, i) => sum + i.lineTotal, 0);
      },
    };
  });

  const directCost = sectionRows.reduce(
    (sum, s) => sum + (excludedTrades.has(s.trade) ? 0 : s.subtotal),
    0,
  );
  const oh = directCost * (parseFloat(overheadPct) || 0) / 100;
  const profit = directCost * (parseFloat(profitPct) || 0) / 100;
  const contingency = directCost * (parseFloat(contingencyPct) || 0) / 100;
  const totalBid = directCost + oh + profit + contingency;

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveBid(takeoffId, {
        prices: savedPrices,
        aiPrices: Object.keys(aiPrices).length > 0 ? aiPrices : undefined,
        aiPricesUpdatedAt: initialBid?.aiPricesUpdatedAt,
        aiPricesZipCode: initialBid?.aiPricesZipCode,
        delegations: Object.keys(delegations).length > 0 ? delegations : undefined,
        excludedTrades: excludedTrades.size > 0 ? [...excludedTrades] : undefined,
        overheadPct: parseFloat(overheadPct) || 0,
        profitPct: parseFloat(profitPct) || 0,
        contingencyPct: parseFloat(contingencyPct) || 0,
      });
      onSaved(saved);
      setSavedAt(new Date());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async () => {
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const saved = await finalizeBid(takeoffId);
      onSaved(saved);
      setFinalizeConfirmOpen(false);
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : 'Finalize failed.');
    } finally {
      setFinalizing(false);
    }
  };

  const handleUnfinalize = async () => {
    setUnfinalizing(true);
    setUnfinalizeError(null);
    try {
      // onSaved clears finalizedAt in the parent's data, which flips `locked` off and
      // re-enables editing across every tab.
      const saved = await unfinalizeBid(takeoffId);
      onSaved(saved);
    } catch (err) {
      setUnfinalizeError(err instanceof Error ? err.message : 'Un-finalize failed.');
      setUnfinalizing(false);
    }
  };

  const handleShare = async () => {
    if (!shareEmail.trim() && !sharePhone.trim()) return;
    setSharing(true);
    setShareError(null);
    setShareSuccess(false);
    try {
      await shareBidPdf(
        takeoffId,
        { email: shareEmail.trim() || undefined, phone: sharePhone.trim() || undefined },
        shareMode,
      );
      setShareSuccess(true);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Send failed.');
    } finally {
      setSharing(false);
    }
  };

  const pctInput = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    amount: number,
  ) => (
    <div className="flex items-center justify-between py-2 text-sm">
      <div className="flex items-center gap-2 text-slate-600">
        {label}
        {readOnly ? (
          <span className="text-xs tabular-nums text-slate-500">{value}%</span>
        ) : (
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="w-16 rounded border border-slate-200 px-2 py-0.5 text-right text-xs tabular-nums focus:border-blue-400 focus:outline-none"
            />
            <span className="text-xs text-slate-400">%</span>
          </div>
        )}
      </div>
      <span className="tabular-nums text-slate-700">{fmt(amount)}</span>
    </div>
  );

  return (
    <div className="mt-4">
      {sectionRows.map((section, i) => {
        const delegatedSub = section.delegation
          ? subcontractors.find((s) => s.id === section.delegation!.subId)
          : null;
        const excluded = excludedTrades.has(section.trade);
        return (
          <div
            key={`${section.trade}-${i}`}
            className={`mt-5 ${excluded ? 'rounded-lg border-l-4 border-rose-400 bg-rose-50/50 py-2 pl-3 pr-2' : ''}`}
          >
            <div className={`flex items-center justify-between border-b pb-1 ${excluded ? 'border-rose-200' : 'border-slate-100'}`}>
              <div className="flex items-center gap-2">
                <h4 className={`text-xs font-semibold uppercase tracking-wide ${excluded ? 'text-rose-400 line-through' : 'text-slate-500'}`}>
                  {section.trade}
                </h4>
                {delegatedSub && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                    {delegatedSub.name}
                  </span>
                )}
                {excluded && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Excluded
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {section.subtotal > 0 && (
                  <span className={`text-xs tabular-nums ${excluded ? 'text-rose-300 line-through' : 'text-slate-400'}`}>
                    {fmt(section.subtotal)}
                  </span>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => toggleExcluded(section.trade)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                      excluded
                        ? 'bg-rose-600 text-white hover:bg-rose-500'
                        : 'border border-slate-200 text-slate-400 hover:border-rose-300 hover:text-rose-600'
                    }`}
                  >
                    {excluded ? 'Include' : 'Exclude'}
                  </button>
                )}
              </div>
            </div>

            <div className={excluded ? 'opacity-50' : undefined}>
            {section.delegation && !section.delegation.approvedAt ? (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {delegatedSub?.name ?? 'The subcontractor'} has not yet approved their bid.
              </div>
            ) : (
              <table className="mt-1.5 w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                    <th className="py-1.5 pr-2 font-medium">Item</th>
                    <th className="w-16 py-1.5 pr-2 text-right font-medium">Qty</th>
                    <th className="w-16 py-1.5 pr-2 font-medium">Unit</th>
                    <th className="w-32 py-1.5 pr-2 text-right font-medium">Unit price</th>
                    <th className="w-24 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item) => (
                    <tr key={item.key} className="border-b border-slate-100 align-middle">
                      <td className="py-1.5 pr-2 text-slate-700">
                        <AcronymText text={item.description} />
                        {item.notes && (
                          <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                        {item.quantity.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-2 text-slate-500"><Unit value={item.unit} /></td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                        {item.unitPrice > 0 ? (
                          <div className="flex items-center justify-end gap-1.5">
                            {item.source === 'ai' && (
                              <Tooltip content="Artificial intelligence — AI-estimated price" className="cursor-help rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">AI</Tooltip>
                            )}
                            {item.source === 'override' && (
                              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Override</span>
                            )}
                            {item.source === 'sub' && (
                              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">Sub quote</span>
                            )}
                            {fmt(item.unitPrice)}
                          </div>
                        ) : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-700">
                        {item.lineTotal > 0 ? fmt(item.lineTotal) : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50">
                    <td colSpan={4} className="py-1.5 pr-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Subtotal
                    </td>
                    <td className="py-1.5 text-right text-sm font-semibold tabular-nums text-slate-800">
                      {section.subtotal > 0 ? fmt(section.subtotal) : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
            </div>
          </div>
        );
      })}

      {/* Markup & totals */}
      <div className="mt-6 rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm font-semibold text-slate-700">
          <span>Direct cost</span>
          <span className="tabular-nums">{directCost > 0 ? fmt(directCost) : '—'}</span>
        </div>
        <div className="divide-y divide-slate-100">
          {pctInput('Overhead', overheadPct, setOverheadPct, oh)}
          {pctInput('Profit', profitPct, setProfitPct, profit)}
          {pctInput('Contingency', contingencyPct, setContingencyPct, contingency)}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
          <span>Total bid</span>
          <span className="tabular-nums">{totalBid > 0 ? fmt(totalBid) : '—'}</span>
        </div>
      </div>

      {/* Save / Finalize row */}
      {initialBid?.finalizedAt ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-green-600" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-xs font-medium text-green-800">
              Finalized {format(new Date(initialBid.finalizedAt), 'MMM d, yyyy')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {unfinalizeError && <span className="text-xs text-red-600">{unfinalizeError}</span>}
            {/* A sent bid is permanently locked — un-finalize is only offered beforehand. */}
            {!initialBid.sentAt && (
              <button
                type="button"
                onClick={handleUnfinalize}
                disabled={unfinalizing}
                className="rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-amber-400 hover:text-amber-700 disabled:cursor-wait disabled:opacity-50"
              >
                {unfinalizing ? 'Un-finalizing…' : 'Un-finalize'}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setShareOpen(true); setShareMode(sharingMode); setShareSuccess(false); setShareError(null); }}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="16 6 12 2 8 6" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="12" y1="2" x2="12" y2="15" strokeLinecap="round" />
              </svg>
              Share bid
            </button>
          </div>
        </div>
      ) : !readOnly && (() => {
        const allApproved = Object.keys(delegations).length === 0 ||
          Object.values(delegations).every((d) => !!d.approvedAt);
        return (
          <div className="mt-4 flex items-center justify-end gap-3">
            {saveError && <span className="text-xs text-red-600">{saveError}</span>}
            {savedAt && !saveError && (
              <span className="text-xs text-slate-400">
                Saved {format(savedAt, 'h:mm a')}
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg border border-slate-200 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save bid'}
            </button>
            <button
              type="button"
              onClick={() => setFinalizeConfirmOpen(true)}
              disabled={!allApproved || totalBid === 0}
              title={!allApproved ? 'All delegated bids must be approved before finalizing' : undefined}
              className="rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Finalize bid
            </button>
          </div>
        );
      })()}

      {/* Finalize confirmation modal */}
      {finalizeConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">Finalize this bid?</h2>
            <p className="mt-2 text-sm text-slate-600">
              Finalizing locks the takeoff, materials list, pricing, and bid as read-only. You can
              un-finalize to make changes any time before the bid is sent to the customer.
            </p>
            {finalizeError && (
              <p className="mt-3 text-sm text-red-600">{finalizeError}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setFinalizeConfirmOpen(false)}
                disabled={finalizing}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFinalize}
                disabled={finalizing}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:cursor-wait disabled:bg-slate-300"
              >
                {finalizing ? 'Finalizing…' : 'Yes, finalize'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share bid modal */}
      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Share bid as PDF</h2>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">Enter an email address, phone number, or both.</p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  placeholder="client@example.com"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Phone (SMS)</label>
                <input
                  type="tel"
                  value={sharePhone}
                  onChange={(e) => setSharePhone(e.target.value)}
                  placeholder="+1 555 000 0000"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-slate-700">PDF format</p>
                <div className="mt-1.5 flex gap-4">
                  {(['summary', 'full'] as BidSharingMode[]).map((mode) => (
                    <label key={mode} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                      <input
                        type="radio"
                        name="shareMode"
                        value={mode}
                        checked={shareMode === mode}
                        onChange={() => setShareMode(mode)}
                        className="accent-blue-600"
                      />
                      {mode === 'summary' ? 'Trade summary' : 'Full line items'}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {shareError && <p className="mt-3 text-sm text-red-600">{shareError}</p>}
            {shareSuccess && (
              <p className="mt-3 text-sm font-medium text-green-700">Sent successfully!</p>
            )}

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {shareSuccess ? 'Done' : 'Cancel'}
              </button>
              {!shareSuccess && (
                <button
                  type="button"
                  onClick={handleShare}
                  disabled={sharing || (!shareEmail.trim() && !sharePhone.trim())}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {sharing ? 'Sending…' : 'Send'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub pricing panel ─────────────────────────────────────────────────────────

interface SubPricingPanelProps {
  takeoffId: string;
  sections: TakeoffSection[];
  delegations: Record<string, DelegationData>;
  onSaved: (updatedDelegations: Record<string, DelegationData>) => void;
}

function SubPricingPanel({ takeoffId, sections, delegations, onSaved }: SubPricingPanelProps) {
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const section of sections) {
      const del = delegations[section.trade];
      if (del?.manualPrices) {
        for (const [key, val] of Object.entries(del.manualPrices)) {
          init[key] = String(val);
        }
      }
    }
    return init;
  });

  const [aiPrices, setAiPrices] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const section of sections) {
      const del = delegations[section.trade];
      if (del?.aiPrices) {
        for (const [key, val] of Object.entries(del.aiPrices)) {
          init[key] = val;
        }
      }
    }
    return init;
  });
  const [aiPricesUpdatedAt, setAiPricesUpdatedAt] = useState<Date | null>(null);
  const [aiPricesZipCode, setAiPricesZipCode] = useState<string | null>(null);
  const [zipPromptOpen, setZipPromptOpen] = useState(false);
  const [zipCode, setZipCode] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFilled, setAiFilled] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const handleAiPricing = async () => {
    if (!zipCode.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiFilled(null);

    const seen = new Set<string>();
    const lineItems: { trade: string; description: string; unit: string }[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        const key = bidKey(section.trade, item.description);
        if (!seen.has(key)) {
          seen.add(key);
          lineItems.push({ trade: section.trade, description: item.description, unit: item.unit });
        }
      }
    }

    try {
      const fetched = await getLocalPricing(zipCode.trim(), lineItems, takeoffId);
      const now = new Date();
      const zip = zipCode.trim();
      setAiPrices(fetched);
      setAiPricesUpdatedAt(now);
      setAiPricesZipCode(zip);
      setAiFilled(Object.keys(fetched).length);
      setZipPromptOpen(false);

      // Auto-save: store aiPrices, manualPrices, and effective prices separately.
      // Merge across sections with the same trade name (duplicate sections can exist).
      const updatedDelegations: Record<string, { prices: Record<string, number>; aiPrices: Record<string, number>; manualPrices: Record<string, number> }> = {};
      for (const section of sections) {
        const entry = (updatedDelegations[section.trade] ??= { prices: {}, aiPrices: {}, manualPrices: {} });
        for (const item of section.items) {
          const key = bidKey(section.trade, item.description);
          const val = prices[key] ?? '';
          const hasManual = val !== '';
          const aiPrice = fetched[key];
          if (aiPrice != null) entry.aiPrices[key] = aiPrice;
          if (hasManual) entry.manualPrices[key] = parseFloat(val);
          const effective = hasManual ? parseFloat(val) : (aiPrice ?? 0);
          if (aiPrice != null || hasManual) entry.prices[key] = effective;
        }
      }
      await saveSubPrices(takeoffId, updatedDelegations);
      const merged: Record<string, DelegationData> = { ...delegations };
      for (const [trade, update] of Object.entries(updatedDelegations)) {
        merged[trade] = { ...delegations[trade], ...update };
      }
      onSaved(merged);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Pricing request failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updatedDelegations: Record<string, { prices: Record<string, number>; aiPrices: Record<string, number>; manualPrices: Record<string, number> }> = {};
      for (const section of sections) {
        const entry = (updatedDelegations[section.trade] ??= { prices: {}, aiPrices: {}, manualPrices: {} });
        for (const item of section.items) {
          const key = bidKey(section.trade, item.description);
          const val = prices[key] ?? '';
          const hasManual = val !== '';
          const aiPrice = aiPrices[key];
          if (aiPrice != null) entry.aiPrices[key] = aiPrice;
          if (hasManual) entry.manualPrices[key] = parseFloat(val);
          const effective = hasManual ? parseFloat(val) : (aiPrice ?? 0);
          if (aiPrice != null || hasManual) entry.prices[key] = effective;
        }
      }
      await saveSubPrices(takeoffId, updatedDelegations);
      setSavedAt(new Date());
      const merged: Record<string, DelegationData> = { ...delegations };
      for (const [trade, update] of Object.entries(updatedDelegations)) {
        merged[trade] = { ...delegations[trade], ...update };
      }
      onSaved(merged);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4">
      {/* AI pricing toolbar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setZipPromptOpen((o) => !o); setAiError(null); }}
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 hover:border-blue-300"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2Z" />
              <path d="M19 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" />
              <path d="M4 15l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8Z" />
            </svg>
            Get AI pricing by zip code
          </button>
          <button
            type="button"
            onClick={() => setPrices({})}
            disabled={Object.keys(prices).length === 0}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear overrides
          </button>
          {aiFilled !== null && (
            <span className="text-xs text-green-700">
              ✓ Filled {aiFilled} price{aiFilled !== 1 ? 's' : ''}
            </span>
          )}
          {aiPricesUpdatedAt && aiFilled === null && (
            <span className="text-xs text-slate-400">
              AI prices last updated {format(aiPricesUpdatedAt, 'MMM d, yyyy')}{aiPricesZipCode && ` · ${aiPricesZipCode}`}
            </span>
          )}
        </div>
        {zipPromptOpen && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3">
            <label className="shrink-0 text-sm text-slate-600">ZIP code</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAiPricing()}
              placeholder="e.g. 90210"
              autoFocus
              className="w-32 rounded border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAiPricing}
              disabled={aiLoading || !zipCode.trim()}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {aiLoading ? 'Fetching…' : 'Get pricing'}
            </button>
            {aiLoading && (
              <span className="text-xs text-slate-400">This may take 15–30 seconds…</span>
            )}
            {aiError && <span className="text-xs text-red-600">{aiError}</span>}
          </div>
        )}
      </div>

      {sections.map((section, i) => {
        const sectionTotal = section.items.reduce((sum, item) => {
          const key = bidKey(section.trade, item.description);
          const val = prices[key] ?? '';
          const unitPrice = val !== '' ? parseFloat(val) : (aiPrices[key] ?? 0);
          return sum + item.quantity * unitPrice;
        }, 0);

        return (
          <div key={`${section.trade}-${i}`} className="mt-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {section.trade}
              </h4>
              {sectionTotal > 0 && (
                <span className="text-xs tabular-nums text-slate-400">{fmt(sectionTotal)}</span>
              )}
            </div>
            <table className="mt-1.5 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">Item</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Qty</th>
                  <th className="py-1.5 pr-3 font-medium">Unit</th>
                  <th className="py-1.5 pr-3 text-right font-medium">AI price</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Your price</th>
                  <th className="py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {section.items.map((item, i) => {
                  const key = bidKey(section.trade, item.description);
                  const val = prices[key] ?? '';
                  const aiPrice = aiPrices[key];
                  const unitPrice = val !== '' ? parseFloat(val) : (aiPrice ?? 0);
                  const lineTotal = item.quantity * unitPrice;
                  return (
                    <tr key={i} className="border-b border-slate-50 align-middle">
                      <td className="py-1.5 pr-3 text-slate-700">
                        <AcronymText text={item.description} />
                        {item.notes && (
                          <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                        {item.quantity.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500"><Unit value={item.unit} /></td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-400">
                        {aiPrice != null ? fmt(aiPrice) : '—'}
                      </td>
                      <td className="py-1 pr-3">
                        <div className="flex items-center justify-end gap-0.5">
                          <span className="text-xs text-slate-400">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={val}
                            onChange={(e) =>
                              setPrices((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            placeholder={aiPrice != null ? String(aiPrice) : '0'}
                            className="w-24 rounded border border-violet-200 bg-violet-50/40 px-2 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none"
                          />
                        </div>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-700">
                        {lineTotal > 0 ? fmt(lineTotal) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      <div className="mt-6 flex items-center justify-end gap-3">
        {saveError && <span className="text-xs text-red-600">{saveError}</span>}
        {savedAt && !saveError && (
          <span className="text-xs text-slate-400">
            Saved {format(savedAt, 'h:mm a')}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-wait disabled:bg-slate-300"
        >
          {saving ? 'Saving…' : 'Save prices'}
        </button>
      </div>
    </div>
  );
}

// ── Sub bids panel ─────────────────────────────────────────────────────────────

interface SubBidsPanelProps {
  takeoffId: string;
  sections: TakeoffSection[];
  delegations: Record<string, DelegationData>;
  gaps: (TakeoffGap | string)[];
  onApproved: (approvedAt: string) => void;
}

function SubBidsPanel({ takeoffId, sections, delegations, gaps, onApproved }: SubBidsPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const trades = [...new Set(sections.map((s) => s.trade))];
  const isApproved = trades.length > 0 && trades.every(
    (t) => !!delegations[t]?.approvedAt,
  );
  const approvedAt = isApproved
    ? new Date(delegations[trades[0]].approvedAt!)
    : null;

  const handleApprove = async () => {
    setApproving(true);
    setApproveError(null);
    try {
      await approveSubBid(takeoffId, trades);
      const ts = new Date().toISOString();
      setConfirmOpen(false);
      onApproved(ts);
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setApproving(false);
    }
  };

  const rows = sections.map((s) => {
    const del = delegations[s.trade];
    return {
      trade: s.trade,
      items: s.items.map((item) => {
        const key = bidKey(s.trade, item.description);
        const unitPrice = del?.prices[key] ?? 0;
        return { ...item, key, unitPrice, lineTotal: item.quantity * unitPrice };
      }),
      get subtotal() {
        return this.items.reduce((sum, i) => sum + i.lineTotal, 0);
      },
    };
  });

  const total = rows.reduce((sum, r) => sum + r.subtotal, 0);
  const hasAnyPrices = rows.some((r) => r.subtotal > 0);

  if (!hasAnyPrices) {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm text-slate-500">
          Enter your prices in the Pricing tab to see a bid summary here.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      {rows.map((row) => (
        <div key={row.trade} className="mt-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {row.trade}
            </h4>
            {row.subtotal > 0 && (
              <span className="text-xs tabular-nums text-slate-400">{fmt(row.subtotal)}</span>
            )}
          </div>
          <table className="mt-1.5 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="py-1.5 pr-2 font-medium">Item</th>
                <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                <th className="py-1.5 pr-2 font-medium">Unit</th>
                <th className="py-1.5 pr-2 text-right font-medium">Unit price</th>
                <th className="py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {row.items.map((item) => (
                <tr key={item.key} className="border-b border-slate-100 align-middle">
                  <td className="py-1.5 pr-2 text-slate-700">
                    <AcronymText text={item.description} />
                    {item.notes && (
                      <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                    {item.quantity.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-2 text-slate-500"><Unit value={item.unit} /></td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                    {item.unitPrice > 0 ? fmt(item.unitPrice) : '—'}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-700">
                    {item.lineTotal > 0 ? fmt(item.lineTotal) : '—'}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50">
                <td colSpan={4} className="py-1.5 pr-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Subtotal
                </td>
                <td className="py-1.5 text-right text-sm font-semibold tabular-nums text-slate-800">
                  {row.subtotal > 0 ? fmt(row.subtotal) : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      <div className="mt-5 flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50 px-5 py-3">
        <span className="text-sm font-semibold text-violet-800">Your total quote</span>
        <span className="text-base font-bold tabular-nums text-violet-900">{fmt(total)}</span>
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        {isApproved && approvedAt && (
          <span className="text-xs text-slate-500">
            Bid approved {format(approvedAt, 'MMM d, yyyy · h:mm a')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isApproved}
          className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-default disabled:bg-slate-300"
        >
          {isApproved ? 'Bid approved' : 'Approve bid'}
        </button>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">Approve your bid?</h2>
            <p className="mt-2 text-sm text-slate-600">
              Your quote of <span className="font-semibold text-slate-900">{fmt(total)}</span> will
              be sent to the general contractor and treated as your final bid. You won't be able to
              change it after approving.
            </p>
            {gaps.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-800">
                  {gaps.length === 1
                    ? '1 item still needs verification.'
                    : `${gaps.length} items still need verification.`}{' '}
                  Your quantity calculations may be off until they are resolved:
                </p>
                <ul className="mt-2 space-y-0.5">
                  {gaps.map((g, i) => {
                    const gap = normalizeGap(g);
                    return (
                      <li key={i} className="flex gap-1.5 text-xs text-amber-700">
                        <span className="mt-px shrink-0">•</span>
                        <span>
                          <span className="font-medium capitalize">{gap.trade}</span>
                          {' — '}{gap.description}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {approveError && (
              <p className="mt-3 text-sm text-red-600">{approveError}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setConfirmOpen(false); setApproveError(null); }}
                disabled={approving}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={approving}
                className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-500 disabled:cursor-wait disabled:bg-slate-300"
              >
                {approving ? 'Approving…' : 'Approve bid'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TakeoffView ───────────────────────────────────────────────────────────────

const EMPTY_MATRIX: PricingMatrix = { unitDefaults: {}, tradeOverrides: [] };

interface TakeoffViewProps {
  takeoff: Takeoff;
  planName: string;
  /** True when another takeoff for this plan has been finalized — locks this one read-only. */
  superseded?: boolean;
  pricingMatrix?: PricingMatrix;
  bidSharingMode?: BidSharingMode;
  subcontractors?: Subcontractor[];
  onSubcontractorAdded?: (sub: Subcontractor) => void;
  mySubIds?: string[];
}

export function TakeoffView({
  takeoff,
  planName,
  superseded = false,
  pricingMatrix = EMPTY_MATRIX,
  bidSharingMode = 'full',
  subcontractors = [],
  onSubcontractorAdded = () => {},
  mySubIds = [],
}: TakeoffViewProps) {
  const [localData, setLocalData] = useState<TakeoffData>(takeoff.data);

  // Determine if the current user is viewing as a subcontractor.
  const mySubIdSet = new Set(mySubIds);
  const myDelegatedTrades = mySubIdSet.size > 0
    ? Object.entries(localData.bid?.delegations ?? {})
        .filter(([, del]) => mySubIdSet.has(del.subId))
        .map(([trade]) => trade)
    : [];
  const isSubView = myDelegatedTrades.length > 0;
  const isFinalized = !!localData.bid?.finalizedAt;
  // Locked = this takeoff is finalized OR a sibling bid for the project was finalized.
  const locked = isFinalized || superseded;

  // Canonical units + this takeoff's AI-generated acronyms (the latter win), keyed uppercase.
  const acronymMap = useMemo(() => {
    const map: Record<string, string> = { ...UNIT_LABELS };
    for (const { abbreviation, meaning } of localData.acronyms ?? []) {
      const key = abbreviation?.trim().toUpperCase();
      if (key && meaning?.trim()) map[key] = meaning.trim();
    }
    return map;
  }, [localData.acronyms]);

  // When in sub view, filter sections to only the delegated trades.
  const subDelegations = localData.bid?.delegations ?? {};
  const [pending, setPending] = useState<Map<string, string>>(new Map());
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParamKey = `tab.${takeoff.id}`;
  const activeTab = (searchParams.get(tabParamKey) as Tab | null) ?? 'takeoff';
  const setActiveTab = (tab: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'takeoff') {
        next.delete(tabParamKey);
      } else {
        next.set(tabParamKey, tab);
      }
      return next;
    }, { replace: true });
  };
  const [materialsModalOpen, setMaterialsModalOpen] = useState(false);
  const [selectedMaterialTrades, setSelectedMaterialTrades] = useState<
    string[] | null
  >(takeoff.data.materialsSelectedTrades ?? null);

  const [activeGap, setActiveGap] = useState<string | null>(null);

  const visibleSections = isSubView
    ? localData.sections.filter((s) => myDelegatedTrades.includes(s.trade))
    : localData.sections;

  const myDelegatedTradeSet = new Set(myDelegatedTrades.map((t) => t.toLowerCase()));
  const visibleGaps = isSubView
    ? localData.gaps.filter((g) => myDelegatedTradeSet.has(normalizeGap(g).trade.toLowerCase()))
    : localData.gaps;

  const availableTrades = localData.sections.map((s) => s.trade);

  const materialsSections: MaterialsSection[] | null = selectedMaterialTrades
    ? visibleSections
        .filter((s) => selectedMaterialTrades.includes(s.trade))
        .map((s) => ({ trade: s.trade, items: s.items }))
    : null;

  const handleSave = (clarification: string) => {
    setPending((prev) => new Map(prev).set(activeGap!, clarification));
    setActiveGap(null);
  };

  const handleUpdate = async () => {
    if (pending.size === 0) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const { updatedSections, resolvedGaps } = await clarifyTakeoff(
        takeoff.id,
        [...pending.entries()].map(([gap, clarification]) => ({
          gap,
          clarification,
        })),
      );
      setLocalData((prev) => {
        const sections = [...prev.sections];
        for (const updated of updatedSections) {
          const idx = sections.findIndex((s) => s.trade === updated.trade);
          if (idx >= 0) sections[idx] = updated;
          else sections.push(updated);
        }
        const resolvedSet = new Set(resolvedGaps);
        return {
          ...prev,
          sections,
          gaps: prev.gaps.filter((g) => !resolvedSet.has(normalizeGap(g).description)),
        };
      });
      setPending(new Map());
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setUpdating(false);
    }
  };

  const openMaterialsModal = () => {
    setMaterialsModalOpen(true);
  };

  return (
    <AcronymContext.Provider value={acronymMap}>
      {materialsModalOpen && (
        <MaterialsModal
          trades={availableTrades}
          initialSelected={selectedMaterialTrades ?? []}
          onGenerate={(trades) => {
            setMaterialsModalOpen(false);
            setSelectedMaterialTrades(trades);
            setActiveTab('materials');
            saveMaterialsList(takeoff.id, trades)
              .then((saved) => setLocalData(saved))
              .catch(console.error);
          }}
          onClose={() => setMaterialsModalOpen(false)}
        />
      )}
      {activeGap !== null && (
        <VerifyModal
          gap={activeGap}
          initialValue={pending.get(activeGap) ?? ''}
          onSave={handleSave}
          onClose={() => setActiveGap(null)}
        />
      )}

      <section className="mt-8 w-full rounded-xl border border-slate-200 bg-white p-6 text-left shadow-sm">
        {/* Card header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">
                {localData.projectName}
              </h2>
              {isSubView && (
                <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-700">
                  Delegated to you
                </span>
              )}
              {isFinalized && (
                <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700">
                  Finalized
                </span>
              )}
              {superseded && !isFinalized && (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                  Superseded
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              From {planName} · generated by {takeoff.model}
            </p>
            {superseded && !isFinalized && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                Another bid for this project has been finalized — this takeoff is read-only.
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!isSubView && !locked && pending.size > 0 && (
              <UpdateButton
                count={pending.size}
                loading={updating}
                error={updateError}
                onClick={handleUpdate}
              />
            )}

          </div>
        </div>

        {/* Tabs */}
        <div className="mt-5 flex border-b border-slate-200">
          {([
            { id: 'takeoff', label: 'Takeoff' },
            { id: 'materials', label: 'Materials' },
            { id: 'pricing', label: 'Pricing' },
            { id: 'bids', label: 'Bid' },
          ] as { id: Tab; label: string }[]).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab panels */}
        {activeTab === 'takeoff' && (
          <TakeoffPanel
            data={isSubView ? { ...localData, sections: visibleSections, gaps: visibleGaps } : localData}
            pending={(isSubView || locked) ? new Map() : pending}
            onVerify={(gap) => setActiveGap(gap)}
            readOnly={locked}
          />
        )}

        {activeTab === 'materials' && (
          isSubView && !materialsSections ? (
            <div className="flex flex-col items-center py-14 text-center">
              <p className="text-sm text-slate-500">
                No materials list has been generated for this project yet.
              </p>
            </div>
          ) : (
            <MaterialsPanel
              takeoffId={takeoff.id}
              sections={materialsSections}
              pending={(isSubView || locked) ? new Map() : pending}
              updating={updating}
              updateError={updateError}
              onVerify={(gap) => setActiveGap(gap)}
              onUpdate={handleUpdate}
              onConfigure={openMaterialsModal}
              initialOverrides={localData.materialsQuantityOverrides ?? {}}
              onOverridesSaved={(overrides) =>
                setLocalData((prev) => ({ ...prev, materialsQuantityOverrides: overrides }))
              }
              readOnly={isSubView || locked}
            />
          )
        )}

        {activeTab === 'pricing' && (
          isSubView ? (
            <SubPricingPanel
              takeoffId={takeoff.id}
              sections={visibleSections}
              delegations={subDelegations}
              onSaved={(updatedDelegations) =>
                setLocalData((prev) => ({
                  ...prev,
                  bid: prev.bid
                    ? { ...prev.bid, delegations: updatedDelegations }
                    : undefined,
                }))
              }
            />
          ) : (
            <PricingPanel
              takeoffId={takeoff.id}
              sections={localData.sections}
              initialBid={localData.bid}
              subcontractors={subcontractors}
              onSubcontractorAdded={onSubcontractorAdded}
              onSaved={setLocalData}
              readOnly={locked}
            />
          )
        )}

        {activeTab === 'bids' && (
          isSubView ? (
            <SubBidsPanel
              takeoffId={takeoff.id}
              sections={visibleSections}
              delegations={subDelegations}
              gaps={visibleGaps}
              onApproved={(approvedAt) =>
                setLocalData((prev) => {
                  const delegations = { ...prev.bid?.delegations };
                  for (const trade of Object.keys(delegations)) {
                    if (delegations[trade]) {
                      delegations[trade] = { ...delegations[trade], approvedAt };
                    }
                  }
                  return { ...prev, bid: prev.bid ? { ...prev.bid, delegations } : prev.bid };
                })
              }
            />
          ) : (
            <BidsPanel
              takeoffId={takeoff.id}
              sections={localData.sections}
              initialBid={localData.bid}
              pricingMatrix={pricingMatrix}
              subcontractors={subcontractors}
              onSaved={setLocalData}
              readOnly={locked}
              sharingMode={bidSharingMode}
            />
          )
        )}
      </section>
    </AcronymContext.Provider>
  );
}
