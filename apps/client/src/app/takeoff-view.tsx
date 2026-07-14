import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Tooltip } from '@bid-wise/common-components';
import type {
  BidData,
  BidSharingMode,
  CustomLineItem,
  DelegationData,
  PriceParts,
  PriceValue,
  PricingMatrix,
  Subcontractor,
  SubDelegationUpdate,
  Takeoff,
  TakeoffData,
  TakeoffGap,
  TakeoffItem,
  TakeoffSection,
} from '../lib/supabase';
import { approveSubBid, bidQuote, clarifyTakeoff, finalizeBid, getLocalPricing, InsufficientCreditsError, priceParts, priceTotal, saveBid, saveLineItemNotes, saveMaterialsList, saveMaterialsOverrides, saveSubPrices, shareBidPdf, unfinalizeBid, type BidQuote } from '../lib/supabase';
import { notifyCreditsChanged } from './billing-screen';
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

/** Tooltip copy explaining how each source classification was determined (see generate-takeoff). */
const sourceBadgeDescriptions: Record<string, string> = {
  stated: 'This quantity is explicitly called out on the plans, e.g. a schedule or note gives the count.',
  derived: 'This quantity was calculated from plan dimensions, e.g. area from a room footprint.',
  estimated: 'This quantity could not be read from the plans — it was estimated from typical construction practice.',
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

/** A staged clarification for a gap: typed text and/or an uploaded supporting file. */
export interface PendingClarification {
  clarification: string;
  file: File | null;
}

const VERIFY_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif';
const MAX_VERIFY_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Reads a File and returns its base64 contents (without the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

// ── Draft clarification persistence ──────────────────────────────────────────
// Staged clarifications live only in memory until the user clicks "Update", so an
// accidental refresh would otherwise wipe them. Mirror them into sessionStorage
// (per takeoff) so they survive a refresh but still clear when the tab closes.

const PENDING_STORAGE_PREFIX = 'bidwise:pendingClarifications:';

interface StoredPendingFile {
  name: string;
  mediaType: string;
  data: string; // base64, no `data:...;base64,` prefix
}

type StoredPendingEntry = [string, { clarification: string; file: StoredPendingFile | null }];

function base64ToFile(stored: StoredPendingFile): File {
  const binary = atob(stored.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], stored.name, { type: stored.mediaType });
}

/** Restores draft clarifications staged before a refresh. Pairs with persistPendingClarifications. */
function loadPendingClarifications(takeoffId: string): Map<string, PendingClarification> {
  try {
    const raw = sessionStorage.getItem(PENDING_STORAGE_PREFIX + takeoffId);
    if (!raw) return new Map();
    const entries: StoredPendingEntry[] = JSON.parse(raw);
    return new Map(
      entries.map(([gap, { clarification, file }]) => [
        gap,
        { clarification, file: file ? base64ToFile(file) : null },
      ]),
    );
  } catch {
    return new Map();
  }
}

/** Mirrors staged clarifications into sessionStorage so a refresh doesn't lose them. */
async function persistPendingClarifications(
  takeoffId: string,
  pending: Map<string, PendingClarification>,
): Promise<void> {
  const key = PENDING_STORAGE_PREFIX + takeoffId;
  if (pending.size === 0) {
    sessionStorage.removeItem(key);
    return;
  }
  try {
    const entries: StoredPendingEntry[] = await Promise.all(
      [...pending.entries()].map(async ([gap, { clarification, file }]): Promise<StoredPendingEntry> => [
        gap,
        {
          clarification,
          file: file
            ? { name: file.name, mediaType: file.type, data: await fileToBase64(file) }
            : null,
        },
      ]),
    );
    sessionStorage.setItem(key, JSON.stringify(entries));
  } catch (err) {
    // Quota exceeded or a file failed to read — drop the draft rather than leave it half-written.
    console.error('[takeoff-view] failed to persist draft clarifications:', err);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

interface VerifyModalProps {
  gap: string;
  initialValue: string;
  initialFile: File | null;
  onSave: (clarification: string, file: File | null) => void;
  onClose: () => void;
}

function VerifyModal({ gap, initialValue, initialFile, onSave, onClose }: VerifyModalProps) {
  const [value, setValue] = useState(initialValue);
  const [file, setFile] = useState<File | null>(initialFile);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePick = (picked: File | null) => {
    if (picked && picked.size > MAX_VERIFY_FILE_BYTES) {
      setFileError('File is too large (max 20 MB).');
      return;
    }
    setFileError(null);
    setFile(picked);
  };

  const canSave = value.trim().length > 0 || file !== null;

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

        {/* File upload — let AI read a spec sheet, photo, or PDF to determine the value */}
        <input
          ref={fileInputRef}
          type="file"
          accept={VERIFY_ACCEPT}
          className="hidden"
          onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-slate-400" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-slate-700">{file.name}</span>
            <button
              type="button"
              onClick={() => handlePick(null)}
              className="shrink-0 text-xs font-medium text-slate-500 underline hover:text-slate-700"
            >
              remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload a file for AI to read
          </button>
        )}
        {fileError && (
          <p className="mt-2 text-xs text-red-600">{fileError}</p>
        )}

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
              if (canSave) onSave(value.trim(), file);
            }}
            disabled={!canSave}
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
  takeoffId: string;
  data: TakeoffData;
  pending: Map<string, PendingClarification>;
  onVerify: (gap: string) => void;
  onNotesSaved: (data: TakeoffData) => void;
  readOnly?: boolean;
  /** Notes/assumptions are editable by the GC only, even when gap verification (readOnly) is not locked. */
  canEditNotes?: boolean;
}

function TakeoffPanel({ takeoffId, data, pending, onVerify, onNotesSaved, readOnly = false, canEditNotes = false }: TakeoffPanelProps) {
  const gaps = data.gaps.map(normalizeGap);
  const unverifiedCount = gaps.filter((gap) => !pending.has(gap.description)).length;

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEditing = (trade: string, item: TakeoffItem) => {
    setEditingKey(`${trade}::${item.description}`);
    setDraft(item.notes ?? '');
    setSaveError(null);
  };

  const cancelEditing = () => {
    setEditingKey(null);
    setSaveError(null);
  };

  const saveEditing = async (trade: string, description: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await saveLineItemNotes(takeoffId, trade, description, draft);
      onNotesSaved(updated);
      setEditingKey(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

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
              {section.items.map((item, i) => {
                const key = `${section.trade}::${item.description}`;
                const isEditing = editingKey === key;
                return (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-1.5 pr-2 text-slate-700">
                      <AcronymText text={item.description} />
                      {isEditing ? (
                        <div className="mt-1">
                          <textarea
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Assumption / note for this line item"
                            rows={2}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-400 focus:outline-none"
                          />
                          {saveError && (
                            <p className="mt-1 text-xs text-red-600">{saveError}</p>
                          )}
                          <div className="mt-1 flex gap-2">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => saveEditing(section.trade, item.description)}
                              className="text-xs font-medium text-blue-600 hover:text-blue-500 disabled:opacity-50"
                            >
                              {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={cancelEditing}
                              className="text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="block text-xs text-slate-400">
                          {item.notes && <AcronymText text={item.notes} />}
                          {canEditNotes && (
                            <button
                              type="button"
                              onClick={() => startEditing(section.trade, item)}
                              className={`font-medium text-blue-600 underline hover:text-blue-500 ${item.notes ? 'ml-1.5' : ''}`}
                            >
                              {item.notes ? 'edit' : 'add assumption'}
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                      {item.quantity.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-500"><Unit value={item.unit} /></td>
                    <td className="py-1.5">
                      <Tooltip
                        content={sourceBadgeDescriptions[item.source]}
                        className="cursor-help"
                      >
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            sourceBadgeStyles[item.source] ??
                            'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {item.source}
                        </span>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
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
              const savedLabel = savedValue
                ? savedValue.clarification || savedValue.file?.name
                : undefined;
              return (
                <li key={`${gap.trade}::${gap.description}`} className="list-disc">
                  <span className="mr-1.5 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                    {gap.trade}
                  </span>
                  {gap.description}
                  {!readOnly && (savedValue ? (
                    <>
                      <span className="ml-2 italic text-blue-700">
                        {savedValue.file && !savedValue.clarification ? '📎 ' : ''}"{savedLabel}"
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
  pending: Map<string, PendingClarification>;
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

  // Save action mirrored at the top and bottom of the panel for convenience.
  const saveRow = !readOnly && (
    <div className="mt-6 flex items-center justify-end gap-3">
      {savedAt && (
        <span className="text-xs text-slate-400">Saved {format(savedAt, 'h:mm a')}</span>
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
  );

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

      {saveRow}

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
                                    {savedValue.file && !savedValue.clarification ? '📎 ' : ''}
                                    "{savedValue.clarification || savedValue.file?.name}"
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

      {saveRow}
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const bidKey = (trade: string, description: string) => `${trade}::${description}`;

type MergedItem = TakeoffItem & { isCustom?: boolean };
interface MergedSection { trade: string; items: MergedItem[] }

/** Merges user-added custom items into the AI takeoff sections — appended to a matching
 *  trade, or as a new trade — flagging each so the UI can distinguish them. The AI
 *  `sections` are never mutated, so the original is always recoverable. */
function mergeSections(sections: TakeoffSection[], customItems: CustomLineItem[] = []): MergedSection[] {
  const merged: MergedSection[] = sections.map((s) => ({ trade: s.trade, items: s.items.map((it) => ({ ...it })) }));
  const byTrade = new Map(merged.map((s) => [s.trade, s]));
  for (const ci of customItems) {
    const item: MergedItem = { description: ci.description, quantity: ci.quantity, unit: ci.unit, source: 'estimated', isCustom: true };
    const existing = byTrade.get(ci.trade);
    if (existing) existing.items.push(item);
    else {
      const ns: MergedSection = { trade: ci.trade, items: [item] };
      merged.push(ns);
      byTrade.set(ci.trade, ns);
    }
  }
  return merged;
}

/** mm:ss from milliseconds. */
const fmtClock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Compact token count, e.g. 14.2K / 1.5M. */
const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

/** Elapsed-time stopwatch (ms) that runs while `running` is true; resets on each start. */
function useStopwatch(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) {
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      if (startRef.current != null) setElapsed(Date.now() - startRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

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
  const [aiPrices, setAiPrices] = useState<Record<string, PriceParts>>(() => {
    const out: Record<string, PriceParts> = {};
    for (const [k, v] of Object.entries(initialBid?.aiPrices ?? {})) out[k] = priceParts(v);
    return out;
  });

  // Per-component manual overrides ('' = not overridden, falls back to the AI value).
  const [manualPrices, setManualPrices] = useState<Record<string, { material: string; labor: string }>>(() => {
    const savedAi = initialBid?.aiPrices ?? {};
    const out: Record<string, { material: string; labor: string }> = {};
    for (const [k, v] of Object.entries(initialBid?.prices ?? {})) {
      const saved = priceParts(v);
      const ai = priceParts(savedAi[k]);
      const material = saved.material !== ai.material ? String(saved.material) : '';
      const labor = saved.labor !== ai.labor ? String(saved.labor) : '';
      if (material !== '' || labor !== '') out[k] = { material, labor };
    }
    return out;
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
  const [aiTokens, setAiTokens] = useState<number | null>(null);
  const [aiDurationMs, setAiDurationMs] = useState<number | null>(null);
  const aiElapsedMs = useStopwatch(aiLoading);
  const [delegations, setDelegations] = useState<Record<string, DelegationData>>(
    initialBid?.delegations ?? {},
  );
  const [delegateModalTrade, setDelegateModalTrade] = useState<string | null>(null);
  const [addSubForTrade, setAddSubForTrade] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Line items struck out here are dropped from totals and hidden from the Bid tab / PDF.
  const [excludedItems, setExcludedItems] = useState<Set<string>>(
    () => new Set(initialBid?.excludedItems ?? []),
  );
  const toggleExcludedItem = (key: string) =>
    setExcludedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // User-added line items, kept separate from the AI takeoff so the original is preserved.
  const [customItems, setCustomItems] = useState<CustomLineItem[]>(initialBid?.customItems ?? []);
  const renderSections = useMemo(() => mergeSections(sections, customItems), [sections, customItems]);

  const removeCustomItem = (trade: string, description: string) =>
    setCustomItems((prev) => prev.filter((c) => !(c.trade === trade && c.description === description)));

  // ── Add-line-item drafts ──
  // `addItemTrade` = the existing trade whose inline "add item" form is open (null = none);
  // `newTradeOpen` = the "add a new trade" form at the bottom is open. Only one at a time.
  const [addItemTrade, setAddItemTrade] = useState<string | null>(null);
  const [newTradeOpen, setNewTradeOpen] = useState(false);
  const [draftTradeName, setDraftTradeName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftUnit, setDraftUnit] = useState('EA');
  const [draftQty, setDraftQty] = useState('1');
  const [draftError, setDraftError] = useState<string | null>(null);

  const resetDraft = () => {
    setDraftTradeName('');
    setDraftDesc('');
    setDraftUnit('EA');
    setDraftQty('1');
    setDraftError(null);
  };
  const openItemForm = (trade: string) => { setAddItemTrade(trade); setNewTradeOpen(false); resetDraft(); };
  const openNewTradeForm = () => { setNewTradeOpen(true); setAddItemTrade(null); resetDraft(); };
  const closeAddForms = () => { setAddItemTrade(null); setNewTradeOpen(false); setDraftError(null); };

  // Validates the shared draft fields and appends a custom item to `trade`.
  const commitCustomItem = (trade: string) => {
    const description = draftDesc.trim();
    const quantity = parseFloat(draftQty);
    const unit = draftUnit.trim() || 'EA';
    if (!trade.trim()) return setDraftError('Enter a trade name.');
    if (!description) return setDraftError('Enter a description.');
    if (!(quantity > 0)) return setDraftError('Enter a quantity greater than 0.');
    const exists =
      customItems.some((c) => c.trade === trade && c.description === description) ||
      sections.some((s) => s.trade === trade && s.items.some((it) => it.description === description));
    if (exists) return setDraftError('That trade already has an item with this description.');
    setCustomItems((prev) => [...prev, { trade: trade.trim(), description, unit, quantity }]);
    closeAddForms();
  };

  // Inline add form, shared by the per-trade "add item" and the bottom "add trade" flows.
  const addItemForm = (onSubmit: () => void, withTradeName: boolean) => (
    <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        {withTradeName && (
          <div className="sm:col-span-3">
            <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Trade</label>
            <input
              type="text"
              value={draftTradeName}
              onChange={(e) => setDraftTradeName(e.target.value)}
              placeholder="New trade name"
              autoFocus
              className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
            />
          </div>
        )}
        <div className={withTradeName ? 'sm:col-span-5' : 'sm:col-span-8'}>
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Description</label>
          <input
            type="text"
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
            placeholder="e.g. Permit fees"
            autoFocus={!withTradeName}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
            className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Qty</label>
          <input
            type="number"
            min={0}
            step="any"
            value={draftQty}
            onChange={(e) => setDraftQty(e.target.value)}
            className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-right text-sm tabular-nums text-slate-700 focus:border-indigo-400 focus:outline-none"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Unit</label>
          <input
            type="text"
            value={draftUnit}
            onChange={(e) => setDraftUnit(e.target.value)}
            placeholder="EA"
            className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
          />
        </div>
      </div>
      {draftError && <p className="mt-2 text-xs text-red-600">{draftError}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={closeAddForms}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
        >
          Add item
        </button>
      </div>
    </div>
  );

  // Effective material+labor parts: delegated sub quote → per-component manual override → AI.
  const effectiveParts = (key: string, trade?: string): PriceParts => {
    if (trade && delegations[trade]) return priceParts(delegations[trade].prices[key]);
    const ai = aiPrices[key] ?? { material: 0, labor: 0 };
    const mp = manualPrices[key];
    return {
      material: mp?.material ? parseFloat(mp.material) || 0 : ai.material,
      labor: mp?.labor ? parseFloat(mp.labor) || 0 : ai.labor,
    };
  };
  const effectiveUnitPrice = (key: string, trade?: string): number => {
    const p = effectiveParts(key, trade);
    return p.material + p.labor;
  };

  const setManualComponent = (key: string, field: 'material' | 'labor', val: string) =>
    setManualPrices((prev) => {
      const cur = prev[key] ?? { material: '', labor: '' };
      return { ...prev, [key]: { ...cur, [field]: val } };
    });

  const setDelegationComponent = (trade: string, key: string, field: 'material' | 'labor', val: string) =>
    setDelegations((prev) => {
      const cur = priceParts(prev[trade].prices[key]);
      return {
        ...prev,
        [trade]: {
          ...prev[trade],
          prices: { ...prev[trade].prices, [key]: { ...cur, [field]: parseFloat(val) || 0 } },
        },
      };
    });

  // Read-only AI material/labor cell.
  const aiCell = (ai: PriceParts | undefined) =>
    ai ? (
      <div className="text-right text-xs leading-tight tabular-nums">
        <div className="text-slate-500">M {fmt(ai.material)}</div>
        <div className="text-slate-400">L {fmt(ai.labor)}</div>
      </div>
    ) : (
      <span className="text-slate-400">—</span>
    );

  // Side-by-side material/labor number inputs.
  const priceInputs = (
    matVal: string,
    labVal: string,
    matPh: string,
    labPh: string,
    onMat: (v: string) => void,
    onLab: (v: string) => void,
    accent: string,
  ) => (
    <div className="flex items-center justify-end gap-1.5">
      {([['M', matVal, matPh, onMat], ['L', labVal, labPh, onLab]] as const).map(([lbl, val, ph, on]) => (
        <div key={lbl} className="flex items-center gap-0.5">
          <span className="text-[10px] text-slate-400">{lbl}</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={val}
            placeholder={ph}
            onChange={(e) => !readOnly && on(e.target.value)}
            readOnly={readOnly}
            className={`w-16 rounded border px-1.5 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:outline-none disabled:opacity-60 ${accent}`}
          />
        </div>
      ))}
    </div>
  );

  // Strike toggle shown at the end of a line item's description cell.
  const excludeToggle = (key: string) =>
    !readOnly && (
      <button
        type="button"
        onClick={() => toggleExcludedItem(key)}
        title={excludedItems.has(key) ? 'Include in bid' : 'Exclude from bid'}
        className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold transition-colors ${
          excludedItems.has(key)
            ? 'bg-rose-600 text-white hover:bg-rose-500'
            : 'border border-slate-200 text-slate-300 hover:border-rose-300 hover:text-rose-600'
        }`}
      >
        {excludedItems.has(key) ? 'Excluded' : 'Exclude'}
      </button>
    );

  const handleAiPricing = async () => {
    if (!zipCode.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiFilled(null);
    setAiTokens(null);
    setAiDurationMs(null);
    const startedAt = Date.now();

    const seen = new Set<string>();
    const lineItems: { trade: string; description: string; unit: string }[] = [];
    for (const section of renderSections) {
      for (const item of section.items) {
        const key = bidKey(section.trade, item.description);
        if (!seen.has(key)) {
          seen.add(key);
          lineItems.push({ trade: section.trade, description: item.description, unit: item.unit });
        }
      }
    }

    try {
      const { prices, totalTokens } = await getLocalPricing(zipCode.trim(), lineItems, takeoffId);
      const now = new Date();
      const zip = zipCode.trim();
      setAiPrices(prices);
      setAiPricesUpdatedAt(now);
      setAiPricesZipCode(zip);
      setAiFilled(Object.keys(prices).length);
      setAiTokens(totalTokens);
      setAiDurationMs(Date.now() - startedAt);
      setZipPromptOpen(false);

      // Auto-save AI prices immediately. Use only actual manual overrides for `prices`
      // (not initialBid.prices, which may contain stale AI prices from a prior save).
      const manualOnly: Record<string, PriceValue> = {};
      for (const k of Object.keys(manualPrices)) {
        const mp = manualPrices[k];
        if (mp.material !== '' || mp.labor !== '') {
          manualOnly[k] = {
            material: mp.material ? parseFloat(mp.material) || 0 : priceParts(prices[k]).material,
            labor: mp.labor ? parseFloat(mp.labor) || 0 : priceParts(prices[k]).labor,
          };
        }
      }
      const savedData = await saveBid(takeoffId, {
        prices: manualOnly,
        aiPrices: prices,
        aiPricesUpdatedAt: now.toISOString(),
        aiPricesZipCode: zip,
        delegations: initialBid?.delegations,
        excludedTrades: initialBid?.excludedTrades,
        excludedItems: excludedItems.size > 0 ? [...excludedItems] : undefined,
        customItems: customItems.length > 0 ? customItems : undefined,
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
      const prices: Record<string, PriceValue> = {};
      for (const section of renderSections) {
        const del = delegations[section.trade];
        for (const item of section.items) {
          const key = bidKey(section.trade, item.description);
          const parts = del ? priceParts(del.prices[key]) : effectiveParts(key);
          if (parts.material + parts.labor > 0) prices[key] = parts;
        }
      }
      const saved = await saveBid(takeoffId, {
        prices,
        aiPrices: Object.keys(aiPrices).length > 0 ? aiPrices : undefined,
        aiPricesUpdatedAt: aiPricesUpdatedAt?.toISOString(),
        aiPricesZipCode: aiPricesZipCode ?? undefined,
        delegations: Object.keys(delegations).length > 0 ? delegations : undefined,
        excludedTrades: initialBid?.excludedTrades,
        excludedItems: excludedItems.size > 0 ? [...excludedItems] : undefined,
        customItems: customItems.length > 0 ? customItems : undefined,
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

  // Save action mirrored at the top and bottom of the panel for convenience.
  const saveRow = !readOnly && (
    <div className="mt-6 flex items-center justify-end gap-3">
      {saveError && <span className="text-xs text-red-600">{saveError}</span>}
      {savedAt && !saveError && (
        <span className="text-xs text-slate-400">Saved {format(savedAt, 'h:mm a')}</span>
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
  );

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
            <span className="text-xs tabular-nums text-green-700">
              ✓ Filled {aiFilled} price{aiFilled !== 1 ? 's' : ''}
              {aiTokens != null && ` · ${fmtTokens(aiTokens)} tokens`}
              {aiDurationMs != null && ` · ${fmtClock(aiDurationMs)}`}
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
              <span className="text-xs tabular-nums text-slate-400">Estimating… {fmtClock(aiElapsedMs)} (usually 15–30s)</span>
            )}
            {aiError && <span className="text-xs text-red-600">{aiError}</span>}
          </div>
        )}
      </div>}

      {saveRow}

      {/* Line items by trade */}
      {renderSections.map((section, i) => {
        const del = delegations[section.trade];
        const delegatedSub = del ? subcontractors.find((s) => s.id === del.subId) : null;
        const sectionTotal = section.items.reduce((sum, item) => {
          const k = bidKey(section.trade, item.description);
          if (excludedItems.has(k)) return sum;
          return sum + item.quantity * effectiveUnitPrice(k, section.trade);
        }, 0);
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
                      <th className="w-12 py-1.5 pr-3 text-right font-medium">Qty</th>
                      <th className="w-12 py-1.5 pr-3 font-medium">Unit</th>
                      <th className="w-44 py-1.5 pr-3 text-right font-medium">Sub quote (mat / labor)</th>
                      <th className="w-24 py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.items.filter((item) => del.prices[bidKey(section.trade, item.description)] != null).map((item, i) => {
                      const key = bidKey(section.trade, item.description);
                      const parts = priceParts(del.prices[key]);
                      const lineTotal = item.quantity * (parts.material + parts.labor);
                      const itemExcluded = excludedItems.has(key);
                      return (
                        <tr key={i} className={`border-b border-slate-50 align-middle ${itemExcluded ? 'bg-rose-50/50' : ''}`}>
                          <td className="py-1.5 pr-3 text-slate-700">
                            <span className={itemExcluded ? 'text-rose-400 line-through' : undefined}>
                              <AcronymText text={item.description} />
                            </span>
                            {excludeToggle(key)}
                            {item.notes && (
                              <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                            {item.quantity.toLocaleString()}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-500"><Unit value={item.unit} /></td>
                          <td className="py-1 pr-3">
                            {priceInputs(
                              parts.material ? String(parts.material) : '',
                              parts.labor ? String(parts.labor) : '',
                              '0',
                              '0',
                              (v) => setDelegationComponent(section.trade, key, 'material', v),
                              (v) => setDelegationComponent(section.trade, key, 'labor', v),
                              'border-violet-200 bg-violet-50/40 focus:border-violet-400',
                            )}
                          </td>
                          <td className={`py-1.5 text-right tabular-nums ${itemExcluded ? 'text-rose-300 line-through' : 'text-slate-700'}`}>
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
                    <th className="w-12 py-1.5 pr-3 text-right font-medium">Qty</th>
                    <th className="w-12 py-1.5 pr-3 font-medium">Unit</th>
                    <th className="w-24 py-1.5 pr-3 text-right font-medium">AI (mat / labor)</th>
                    <th className="w-44 py-1.5 pr-3 text-right font-medium">Override (mat / labor)</th>
                    <th className="w-24 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, i) => {
                    const key = bidKey(section.trade, item.description);
                    const ai = aiPrices[key];
                    const mp = manualPrices[key];
                    const lineTotal = item.quantity * effectiveUnitPrice(key);
                    const itemExcluded = excludedItems.has(key);
                    const isCustom = !!item.isCustom;
                    return (
                      <tr key={i} className={`border-b border-slate-50 align-middle ${itemExcluded ? 'bg-rose-50/50' : isCustom ? 'bg-indigo-50/60' : ''}`}>
                        <td className="py-1.5 pr-3 text-slate-700">
                          <span className={itemExcluded ? 'text-rose-400 line-through' : isCustom ? 'font-medium text-indigo-900' : undefined}>
                            <AcronymText text={item.description} />
                          </span>
                          {isCustom && (
                            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                              Custom
                            </span>
                          )}
                          {isCustom && !readOnly && (
                            <button
                              type="button"
                              onClick={() => removeCustomItem(section.trade, item.description)}
                              title="Remove this custom item"
                              className="ml-1.5 rounded px-1 align-middle text-[11px] font-semibold text-slate-300 transition-colors hover:text-red-600"
                            >
                              ✕
                            </button>
                          )}
                          {excludeToggle(key)}
                          {item.notes && (
                            <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                          {item.quantity.toLocaleString()}
                        </td>
                        <td className="py-1.5 pr-3 text-slate-500"><Unit value={item.unit} /></td>
                        <td className="py-1.5 pr-3">{aiCell(ai)}</td>
                        <td className="py-1 pr-3">
                          {priceInputs(
                            mp?.material ?? '',
                            mp?.labor ?? '',
                            ai ? String(ai.material) : '0',
                            ai ? String(ai.labor) : '0',
                            (v) => setManualComponent(key, 'material', v),
                            (v) => setManualComponent(key, 'labor', v),
                            'border-slate-200 focus:border-blue-400',
                          )}
                        </td>
                        <td className={`py-1.5 text-right tabular-nums ${itemExcluded ? 'text-rose-300 line-through' : 'text-slate-700'}`}>
                          {lineTotal > 0 ? fmt(lineTotal) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Append a custom item to this trade */}
            {!del && !readOnly && (
              addItemTrade === section.trade ? (
                addItemForm(() => commitCustomItem(section.trade), false)
              ) : (
                <button
                  type="button"
                  onClick={() => openItemForm(section.trade)}
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-indigo-700"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                  Add item to {section.trade}
                </button>
              )
            )}
          </div>
        );
      })}

      {/* Add a new trade (with its first line item) */}
      {!readOnly && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          {newTradeOpen ? (
            addItemForm(() => commitCustomItem(draftTradeName), true)
          ) : (
            <button
              type="button"
              onClick={openNewTradeForm}
              className="flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-indigo-300 hover:text-indigo-700"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
              Add a new trade
            </button>
          )}
          <p className="mt-2 text-[11px] text-slate-400">
            Custom items are kept separate from the AI takeoff — delete them any time to revert to the original.
          </p>
        </div>
      )}

      {/* Save row */}
      {saveRow}

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
  // Line items struck out on the Pricing tab — hidden here and dropped from totals.
  const excludedItems = new Set(initialBid?.excludedItems ?? []);

  const [overheadPct, setOverheadPct] = useState(String(initialBid?.overheadPct ?? 10));
  const [profitPct, setProfitPct] = useState(String(initialBid?.profitPct ?? 10));
  const [contingencyPct, setContingencyPct] = useState(String(initialBid?.contingencyPct ?? 5));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const navigate = useNavigate();
  const [finalizeConfirmOpen, setFinalizeConfirmOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [quote, setQuote] = useState<BidQuote | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [unfinalizing, setUnfinalizing] = useState(false);
  const [unfinalizeError, setUnfinalizeError] = useState<string | null>(null);

  // Load the tier/price/balance quote when the finalize modal opens.
  useEffect(() => {
    if (!finalizeConfirmOpen) return;
    setQuote(null);
    setInsufficient(false);
    setFinalizeError(null);
    bidQuote(takeoffId).then(setQuote).catch(() => setQuote(null));
  }, [finalizeConfirmOpen, takeoffId]);

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

  const effectiveParts = (key: string, trade?: string): PriceParts => {
    if (trade && delegations[trade]) return priceParts(delegations[trade].prices[key]);
    const saved = savedPrices[key];
    if (saved !== undefined && priceTotal(saved) > 0) return priceParts(saved);
    // Pricing-matrix fallback is a single rate with no split — treat it as material.
    const matrixRate = (() => {
      for (const s of sections) {
        const item = s.items.find((i) => bidKey(s.trade, i.description) === key);
        if (item) return matrixPriceFor(pricingMatrix, s.trade, item.unit);
      }
      return undefined;
    })();
    return { material: matrixRate ?? 0, labor: 0 };
  };

  const priceSource = (key: string, trade?: string): 'ai' | 'override' | 'sub' | null => {
    if (trade && delegations[trade]) {
      return priceTotal(delegations[trade].prices[key]) > 0 ? 'sub' : null;
    }
    const saved = savedPrices[key];
    if (saved === undefined || priceTotal(saved) === 0) return null;
    const sp = priceParts(saved);
    const ai = aiPrices[key];
    if (ai !== undefined) {
      const ap = priceParts(ai);
      if (sp.material === ap.material && sp.labor === ap.labor) return 'ai';
    }
    return 'override';
  };

  // Merge user-added custom items in so they appear in the bid and its totals.
  const mergedSections = mergeSections(sections, initialBid?.customItems);
  const sectionRows = mergedSections
    .map((s) => {
      const del = delegations[s.trade];
      return {
        trade: s.trade,
        delegation: del,
        // Struck-out items are dropped here so they're hidden and uncounted in the bid.
        items: s.items
          .filter((item) => !excludedItems.has(bidKey(s.trade, item.description)))
          .map((item) => {
            const key = bidKey(s.trade, item.description);
            const parts = effectiveParts(key, s.trade);
            const lineMaterial = item.quantity * parts.material;
            const lineLabor = item.quantity * parts.labor;
            return {
              ...item,
              key,
              parts,
              unitPrice: parts.material + parts.labor,
              source: priceSource(key, s.trade),
              lineMaterial,
              lineLabor,
              lineTotal: lineMaterial + lineLabor,
            };
          }),
        get subtotal() {
          return this.items.reduce((sum, i) => sum + i.lineTotal, 0);
        },
        get materialSubtotal() {
          return this.items.reduce((sum, i) => sum + i.lineMaterial, 0);
        },
        get laborSubtotal() {
          return this.items.reduce((sum, i) => sum + i.lineLabor, 0);
        },
      };
    })
    // A section whose items are all excluded disappears from the bid entirely.
    .filter((s) => s.items.length > 0);

  const directCost = sectionRows.reduce(
    (sum, s) => sum + (excludedTrades.has(s.trade) ? 0 : s.subtotal),
    0,
  );
  const materialDirect = sectionRows.reduce(
    (sum, s) => sum + (excludedTrades.has(s.trade) ? 0 : s.materialSubtotal),
    0,
  );
  const laborDirect = sectionRows.reduce(
    (sum, s) => sum + (excludedTrades.has(s.trade) ? 0 : s.laborSubtotal),
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
        excludedItems: initialBid?.excludedItems,
        customItems: initialBid?.customItems,
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
    setInsufficient(false);
    try {
      const saved = await finalizeBid(takeoffId);
      onSaved(saved);
      notifyCreditsChanged(); // refresh the header balance after the charge
      setFinalizeConfirmOpen(false);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        setInsufficient(true);
      } else {
        setFinalizeError(err instanceof Error ? err.message : 'Finalize failed.');
      }
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

  // Save / Finalize / Share actions, mirrored at the top and bottom of the panel.
  const actionRow = initialBid?.finalizedAt ? (
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
          <span className="text-xs text-slate-400">Saved {format(savedAt, 'h:mm a')}</span>
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
  })();

  return (
    <div className="mt-4">
      {actionRow}

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
                    <th className="w-12 py-1.5 pr-2 text-right font-medium">Qty</th>
                    <th className="w-12 py-1.5 pr-2 font-medium">Unit</th>
                    <th className="w-24 py-1.5 pr-2 text-right font-medium">Material</th>
                    <th className="w-24 py-1.5 pr-2 text-right font-medium">Labor</th>
                    <th className="w-24 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item) => (
                    <tr key={item.key} className="border-b border-slate-100 align-middle">
                      <td className="py-1.5 pr-2 text-slate-700">
                        <span className="inline-flex items-center gap-1.5">
                          <AcronymText text={item.description} />
                          {item.source === 'ai' && (
                            <Tooltip content="Artificial intelligence — AI-estimated price" className="cursor-help rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">AI</Tooltip>
                          )}
                          {item.source === 'override' && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Override</span>
                          )}
                          {item.source === 'sub' && (
                            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">Sub quote</span>
                          )}
                        </span>
                        {item.notes && (
                          <span className="block text-xs text-slate-400"><AcronymText text={item.notes} /></span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                        {item.quantity.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-2 text-slate-500"><Unit value={item.unit} /></td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                        {item.lineMaterial > 0 ? fmt(item.lineMaterial) : '—'}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                        {item.lineLabor > 0 ? fmt(item.lineLabor) : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-700">
                        {item.lineTotal > 0 ? fmt(item.lineTotal) : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50">
                    <td colSpan={3} className="py-1.5 pr-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Subtotal
                    </td>
                    <td className="py-1.5 pr-2 text-right text-sm font-semibold tabular-nums text-slate-600">
                      {section.materialSubtotal > 0 ? fmt(section.materialSubtotal) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-sm font-semibold tabular-nums text-slate-600">
                      {section.laborSubtotal > 0 ? fmt(section.laborSubtotal) : '—'}
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
        <div className="flex items-center justify-between py-1 text-sm text-slate-500">
          <span>Materials</span>
          <span className="tabular-nums">{materialDirect > 0 ? fmt(materialDirect) : '—'}</span>
        </div>
        <div className="flex items-center justify-between py-1 text-sm text-slate-500">
          <span>Labor</span>
          <span className="tabular-nums">{laborDirect > 0 ? fmt(laborDirect) : '—'}</span>
        </div>
        <div className="flex items-center justify-between border-y border-slate-100 py-2 text-sm font-semibold text-slate-700">
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

      {/* Save / Finalize row (mirrored at the top of the panel) */}
      {actionRow}

      {/* Finalize confirmation modal */}
      {finalizeConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">Finalize this bid?</h2>
            <p className="mt-2 text-sm text-slate-600">
              Finalizing locks the takeoff, materials list, pricing, and bid as read-only. You can
              un-finalize to make changes any time before the bid is sent to the customer.
            </p>

            {/* Pricing summary from the quote */}
            {quote && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                {quote.alreadyPaid ? (
                  <p className="text-slate-600">
                    This bid is already paid for — finalizing again won&rsquo;t charge you.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">
                        Charge (<span className="capitalize">{quote.tier}</span> bid)
                      </span>
                      <span className="font-semibold tabular-nums text-slate-900">
                        {fmt(quote.priceCents / 100)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                      <span>Credit balance</span>
                      <span className="tabular-nums">{fmt(quote.balanceCents / 100)}</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {insufficient && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Not enough credits to finalize this bid. Add credits and try again.
              </div>
            )}
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
              {insufficient ? (
                <button
                  type="button"
                  onClick={() => navigate('/billing')}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                >
                  Buy credits
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={finalizing}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:cursor-wait disabled:bg-slate-300"
                >
                  {finalizing
                    ? 'Finalizing…'
                    : quote && !quote.alreadyPaid
                    ? `Pay ${fmt(quote.priceCents / 100)} & finalize`
                    : 'Yes, finalize'}
                </button>
              )}
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
  // The sub's quote, entered as separate material + labor components (strings for inputs).
  const [prices, setPrices] = useState<Record<string, { material: string; labor: string }>>(() => {
    const init: Record<string, { material: string; labor: string }> = {};
    for (const section of sections) {
      const del = delegations[section.trade];
      if (del?.manualPrices) {
        for (const [key, val] of Object.entries(del.manualPrices)) {
          const p = priceParts(val);
          init[key] = { material: String(p.material), labor: String(p.labor) };
        }
      }
    }
    return init;
  });

  const [aiPrices, setAiPrices] = useState<Record<string, PriceParts>>(() => {
    const init: Record<string, PriceParts> = {};
    for (const section of sections) {
      const del = delegations[section.trade];
      if (del?.aiPrices) {
        for (const [key, val] of Object.entries(del.aiPrices)) init[key] = priceParts(val);
      }
    }
    return init;
  });

  // Effective material/labor: the sub's typed component if present, else the AI value.
  const effectiveParts = (key: string, aiMap: Record<string, PriceParts>): PriceParts => {
    const ai = aiMap[key] ?? { material: 0, labor: 0 };
    const mp = prices[key];
    return {
      material: mp?.material !== undefined && mp.material !== '' ? parseFloat(mp.material) || 0 : ai.material,
      labor: mp?.labor !== undefined && mp.labor !== '' ? parseFloat(mp.labor) || 0 : ai.labor,
    };
  };

  const setSubComponent = (key: string, field: 'material' | 'labor', val: string) =>
    setPrices((prev) => {
      const cur = prev[key] ?? { material: '', labor: '' };
      return { ...prev, [key]: { ...cur, [field]: val } };
    });

  // Build the per-trade delegation update (prices/aiPrices/manualPrices as PriceParts).
  const buildDelegations = (aiMap: Record<string, PriceParts>) => {
    const out: Record<string, SubDelegationUpdate> = {};
    for (const section of sections) {
      const entry = (out[section.trade] ??= { prices: {}, aiPrices: {}, manualPrices: {} });
      for (const item of section.items) {
        const key = bidKey(section.trade, item.description);
        const mp = prices[key];
        const hasManual = !!mp && (mp.material !== '' || mp.labor !== '');
        const ai = aiMap[key];
        if (ai) entry.aiPrices![key] = ai;
        if (hasManual) {
          entry.manualPrices![key] = {
            material: mp.material ? parseFloat(mp.material) || 0 : 0,
            labor: mp.labor ? parseFloat(mp.labor) || 0 : 0,
          };
        }
        if (ai || hasManual) entry.prices[key] = effectiveParts(key, aiMap);
      }
    }
    return out;
  };
  const [aiPricesUpdatedAt, setAiPricesUpdatedAt] = useState<Date | null>(null);
  const [aiPricesZipCode, setAiPricesZipCode] = useState<string | null>(null);
  const [zipPromptOpen, setZipPromptOpen] = useState(false);
  const [zipCode, setZipCode] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFilled, setAiFilled] = useState<number | null>(null);
  const [aiTokens, setAiTokens] = useState<number | null>(null);
  const [aiDurationMs, setAiDurationMs] = useState<number | null>(null);
  const aiElapsedMs = useStopwatch(aiLoading);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const handleAiPricing = async () => {
    if (!zipCode.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiFilled(null);
    setAiTokens(null);
    setAiDurationMs(null);
    const startedAt = Date.now();

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
      const { prices: fetched, totalTokens } = await getLocalPricing(zipCode.trim(), lineItems, takeoffId);
      const now = new Date();
      const zip = zipCode.trim();
      setAiPrices(fetched);
      setAiPricesUpdatedAt(now);
      setAiPricesZipCode(zip);
      setAiFilled(Object.keys(fetched).length);
      setAiTokens(totalTokens);
      setAiDurationMs(Date.now() - startedAt);
      setZipPromptOpen(false);

      // Auto-save: store aiPrices, manualPrices, and effective prices separately.
      const updatedDelegations = buildDelegations(fetched);
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
      const updatedDelegations = buildDelegations(aiPrices);
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
            <span className="text-xs tabular-nums text-green-700">
              ✓ Filled {aiFilled} price{aiFilled !== 1 ? 's' : ''}
              {aiTokens != null && ` · ${fmtTokens(aiTokens)} tokens`}
              {aiDurationMs != null && ` · ${fmtClock(aiDurationMs)}`}
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
              <span className="text-xs tabular-nums text-slate-400">Estimating… {fmtClock(aiElapsedMs)} (usually 15–30s)</span>
            )}
            {aiError && <span className="text-xs text-red-600">{aiError}</span>}
          </div>
        )}
      </div>

      {sections.map((section, i) => {
        const sectionTotal = section.items.reduce((sum, item) => {
          const key = bidKey(section.trade, item.description);
          const p = effectiveParts(key, aiPrices);
          return sum + item.quantity * (p.material + p.labor);
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
            <table className="mt-1.5 w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">Item</th>
                  <th className="w-12 py-1.5 pr-3 text-right font-medium">Qty</th>
                  <th className="w-12 py-1.5 pr-3 font-medium">Unit</th>
                  <th className="w-24 py-1.5 pr-3 text-right font-medium">AI (mat / labor)</th>
                  <th className="w-44 py-1.5 pr-3 text-right font-medium">Your quote (mat / labor)</th>
                  <th className="w-24 py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {section.items.map((item, i) => {
                  const key = bidKey(section.trade, item.description);
                  const mp = prices[key];
                  const ai = aiPrices[key];
                  const eff = effectiveParts(key, aiPrices);
                  const lineTotal = item.quantity * (eff.material + eff.labor);
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
                      <td className="py-1.5 pr-3">
                        {ai ? (
                          <div className="text-right text-xs leading-tight tabular-nums">
                            <div className="text-slate-500">M {fmt(ai.material)}</div>
                            <div className="text-slate-400">L {fmt(ai.labor)}</div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-1 pr-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {([['M', mp?.material ?? '', ai ? String(ai.material) : '0', 'material'], ['L', mp?.labor ?? '', ai ? String(ai.labor) : '0', 'labor']] as const).map(
                            ([lbl, v, ph, field]) => (
                              <div key={lbl} className="flex items-center gap-0.5">
                                <span className="text-[10px] text-slate-400">{lbl}</span>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={v}
                                  placeholder={ph}
                                  onChange={(e) => setSubComponent(key, field, e.target.value)}
                                  className="w-16 rounded border border-violet-200 bg-violet-50/40 px-1.5 py-0.5 text-right text-sm tabular-nums text-slate-700 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none"
                                />
                              </div>
                            ),
                          )}
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
        const unitPrice = priceTotal(del?.prices[key]);
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
  const [pending, setPending] = useState<Map<string, PendingClarification>>(() =>
    loadPendingClarifications(takeoff.id),
  );
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

  const handleSave = (clarification: string, file: File | null) => {
    setPending((prev) => {
      const next = new Map(prev).set(activeGap!, { clarification, file });
      void persistPendingClarifications(takeoff.id, next);
      return next;
    });
    setActiveGap(null);
  };

  const handleUpdate = async () => {
    if (pending.size === 0) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const clarificationInputs = await Promise.all(
        [...pending.entries()].map(async ([gap, { clarification, file }]) => ({
          gap,
          clarification,
          file: file
            ? { name: file.name, mediaType: file.type, data: await fileToBase64(file) }
            : null,
        })),
      );
      const { updatedSections, resolvedGaps } = await clarifyTakeoff(
        takeoff.id,
        clarificationInputs,
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
      void persistPendingClarifications(takeoff.id, new Map());
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
          initialValue={pending.get(activeGap)?.clarification ?? ''}
          initialFile={pending.get(activeGap)?.file ?? null}
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
            takeoffId={takeoff.id}
            data={isSubView ? { ...localData, sections: visibleSections, gaps: visibleGaps } : localData}
            pending={(isSubView || locked) ? new Map() : pending}
            onVerify={(gap) => setActiveGap(gap)}
            onNotesSaved={setLocalData}
            readOnly={locked}
            canEditNotes={!isSubView && !locked}
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
