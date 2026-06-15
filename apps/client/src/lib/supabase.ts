import { createClient, type Session } from '@supabase/supabase-js';
import { gql } from '@apollo/client';
import { apolloClient } from '@bid-wise/data';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const apiUrl = (import.meta.env.VITE_API_URL as string) ?? 'http://localhost:4000';

export const supabase = createClient(supabaseUrl, supabaseKey);

export const HOUSE_PLANS_BUCKET = 'house-plans';

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('Sign in failed.');
  return data.session;
}

/** Signs up a new user. If an anonymous session exists, upgrades it in place so existing data is preserved. */
export async function signUp(
  email: string,
  password: string,
): Promise<{ session: Session | null; needsConfirmation: boolean }> {
  const { data: { session: current } } = await supabase.auth.getSession();
  if (current?.user.is_anonymous) {
    const { data, error } = await supabase.auth.updateUser({ email, password });
    if (error) throw error;
    return { session: data.user ? current : null, needsConfirmation: !data.user };
  }
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return { session: data.session ?? null, needsConfirmation: !data.session };
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export interface HousePlan {
  id: string;
  file_name: string;
  storage_path: string;
  file_size: number;
  content_type: string | null;
  created_at: string;
}

export async function listHousePlans(): Promise<HousePlan[]> {
  const { data, error } = await supabase
    .from('house_plans')
    .select('id, file_name, storage_path, file_size, content_type, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export interface TakeoffItem {
  description: string;
  quantity: number;
  unit: string;
  source: 'stated' | 'derived' | 'estimated';
  notes?: string;
}

export interface TakeoffSection {
  trade: string;
  items: TakeoffItem[];
}

export interface DelegationData {
  subId: string;
  /** Effective unit price used in the GC's bid (manual override if set, else AI) */
  prices: Record<string, number>;
  /** AI-fetched unit prices — separate from manual overrides */
  aiPrices?: Record<string, number>;
  /** Explicit manual overrides entered by the sub */
  manualPrices?: Record<string, number>;
  /** ISO timestamp when the sub formally approved their bid */
  approvedAt?: string;
}

export interface SubDelegationUpdate {
  prices: Record<string, number>;
  aiPrices?: Record<string, number>;
  manualPrices?: Record<string, number>;
}

export interface BidData {
  /** key: `${trade}::${description}` → unit price */
  prices: Record<string, number>;
  /** Prices that came from AI — used to distinguish them from manual overrides on reload */
  aiPrices?: Record<string, number>;
  /** ISO timestamp of when AI prices were last fetched */
  aiPricesUpdatedAt?: string;
  /** ZIP code used for the last AI pricing fetch */
  aiPricesZipCode?: string;
  /** trade name → delegation (sub id + their quoted prices) */
  delegations?: Record<string, DelegationData>;
  /** Trades excluded from this bid — their subtotals are dropped from the grand total. */
  excludedTrades?: string[];
  overheadPct: number;
  profitPct: number;
  contingencyPct: number;
  updatedAt?: string;
  finalizedAt?: string;
  /** ISO timestamp when the finalized bid was sent to the customer. Locks the project. */
  sentAt?: string;
}

export interface TradeOverride {
  trade: string;
  unit: string;
  rate: number;
}

export interface PricingMatrix {
  /** unit (SF, LF, CY, …) → default price */
  unitDefaults: Record<string, number>;
  /** per-trade overrides; trade+unit pair takes precedence over unitDefaults */
  tradeOverrides: TradeOverride[];
}

export type BidSharingMode = 'full' | 'summary';

export interface UserSettings {
  pricingMatrix: PricingMatrix;
  trades: string[];
  dismissedNotices: string[];
  bidSharingMode: BidSharingMode;
}

export interface TakeoffGap {
  trade: string;
  description: string;
}

export interface TakeoffData {
  projectName: string;
  summary: string;
  areas: { name: string; squareFeet: number }[];
  sections: TakeoffSection[];
  /** Gaps may be legacy strings (old takeoffs) or structured TakeoffGap objects. */
  gaps: (TakeoffGap | string)[];
  /** AI-generated meanings for abbreviations/acronyms used in this takeoff. */
  acronyms?: { abbreviation: string; meaning: string }[];
  materialsSelectedTrades?: string[];
  /** `${trade}::${description}` → overridden quantity */
  materialsQuantityOverrides?: Record<string, number>;
  bid?: BidData;
}

export interface Takeoff {
  id: string;
  plan_id: string;
  model: string;
  data: TakeoffData;
  created_at: string;
}

export async function listTakeoffs(planId: string): Promise<Takeoff[]> {
  const { data, error } = await supabase
    .from('takeoffs')
    .select('id, plan_id, model, data, created_at')
    .eq('plan_id', planId)
    .eq('archived', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function deleteTakeoff(id: string): Promise<void> {
  const { error } = await supabase.from('takeoffs').delete().eq('id', id);
  if (error) throw error;
}

export async function archiveTakeoff(id: string): Promise<void> {
  const { error } = await supabase.from('takeoffs').update({ archived: true }).eq('id', id);
  if (error) throw error;
}

/** Returns a map of takeoff_id → total_tokens from the takeoff_token_usage view. */
export async function listTakeoffTokenUsage(
  takeoffIds: string[],
): Promise<Record<string, number>> {
  if (takeoffIds.length === 0) return {};
  const { data, error } = await supabase
    .from('takeoff_token_usage')
    .select('takeoff_id, total_tokens')
    .in('takeoff_id', takeoffIds);
  if (error) throw error;
  return Object.fromEntries(
    (data ?? []).map((row) => [row.takeoff_id as string, row.total_tokens as number]),
  );
}

export async function getTakeoff(id: string): Promise<Takeoff> {
  const { data, error } = await supabase
    .from('takeoffs')
    .select('id, plan_id, model, data, created_at')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

/** Returns a finalized (non-archived) takeoff for the plan, if one exists. Used to mark
 *  the other takeoffs as superseded once a bid has been committed. RLS-scoped to the user. */
export async function getFinalizedTakeoffForPlan(planId: string): Promise<Takeoff | null> {
  const { data, error } = await supabase
    .from('takeoffs')
    .select('id, plan_id, model, data, created_at')
    .eq('plan_id', planId)
    .eq('archived', false)
    .not('data->bid->>finalizedAt', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** True if any non-archived takeoff for the plan has a bid that was sent to the customer.
 *  Used to lock the project from new takeoffs. RLS-scoped to the user. */
export async function planHasSentBid(planId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('takeoffs')
    .select('id')
    .eq('plan_id', planId)
    .eq('archived', false)
    .not('data->bid->>sentAt', 'is', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Pulls a human-readable message out of an ApolloError (GraphQL or network), with
 *  the same timeout-friendly mapping the edge-function caller used to apply. */
function gqlErrorMessage(error: unknown, fallback: string): string {
  const map = (msg: string) =>
    msg.toLowerCase().includes('timeout')
      ? 'The request timed out — this can happen for large plans. Please try again.'
      : msg;

  if (error && typeof error === 'object') {
    const e = error as {
      graphQLErrors?: { message: string }[];
      networkError?: { message?: string };
      message?: string;
    };
    if (e.graphQLErrors?.length && e.graphQLErrors[0].message) return map(e.graphQLErrors[0].message);
    if (e.networkError?.message) return map(e.networkError.message);
    if (e.message) return map(e.message);
  }
  return fallback;
}

/** Authorization header carrying the current Supabase access token, for GraphQL calls. */
async function authContext(): Promise<{ headers: Record<string, string> }> {
  const { data: { session } } = await supabase.auth.getSession();
  return { headers: { Authorization: `Bearer ${session?.access_token ?? supabaseKey}` } };
}

export type TakeoffPhase = 'reading' | 'analyzing' | 'compiling' | 'saving';

const TAKEOFF_JOB_STALE_MS = 10 * 60 * 1000;

export interface TakeoffJob {
  id: string;
  plan_id: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  phase: TakeoffPhase | null;
  trades: string[];
  narration: string | null;
  error: string | null;
  takeoff_id: string | null;
  created_at: string;
  updated_at: string;
}

const TAKEOFF_JOB_COLUMNS = 'id, plan_id, status, phase, trades, narration, error, takeoff_id, created_at, updated_at';

/** Returns the active (running, non-stale) generation job for a plan, or null.
 *  RLS scopes the query to the current user. */
export async function getActiveTakeoffJob(planId: string): Promise<TakeoffJob | null> {
  const { data, error } = await supabase
    .from('takeoff_jobs')
    .select(TAKEOFF_JOB_COLUMNS)
    .eq('plan_id', planId)
    .eq('status', 'running')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Mirror the server's staleness rule so a crashed run doesn't look active.
  if (Date.now() - new Date(data.updated_at).getTime() > TAKEOFF_JOB_STALE_MS) return null;
  return data as TakeoffJob;
}

/** All active (running, non-stale) generation jobs for the current user, across plans.
 *  Used by the multi-plan (no specific plan) questionnaire flow. */
export async function getActiveTakeoffJobs(): Promise<TakeoffJob[]> {
  const { data, error } = await supabase
    .from('takeoff_jobs')
    .select(TAKEOFF_JOB_COLUMNS)
    .eq('status', 'running')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const now = Date.now();
  return (data ?? []).filter(
    (j) => now - new Date(j.updated_at).getTime() <= TAKEOFF_JOB_STALE_MS,
  ) as TakeoffJob[];
}

function authorizeRealtime(): void {
  void supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.access_token) supabase.realtime.setAuth(session.access_token);
  });
}

/** Subscribes to takeoff_jobs changes for a plan via Realtime. Returns an unsubscribe fn.
 *  Authorizes the Realtime connection with the current session so RLS applies. */
export function subscribeTakeoffJob(
  planId: string,
  onChange: (job: TakeoffJob) => void,
): () => void {
  authorizeRealtime();
  const channel = supabase
    .channel(`takeoff_job:${planId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'takeoff_jobs', filter: `plan_id=eq.${planId}` },
      (payload) => {
        if (payload.new && 'id' in payload.new) onChange(payload.new as TakeoffJob);
      },
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

/** Subscribes to all of the current user's takeoff_jobs changes (RLS-scoped). */
export function subscribeUserTakeoffJobs(onChange: (job: TakeoffJob) => void): () => void {
  authorizeRealtime();
  const channel = supabase
    .channel('takeoff_jobs:user')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'takeoff_jobs' },
      (payload) => {
        if (payload.new && 'id' in payload.new) onChange(payload.new as TakeoffJob);
      },
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

type TakeoffStreamEvent =
  | { type: 'phase'; phase: TakeoffPhase }
  | { type: 'token'; text: string }
  | { type: 'progress'; trades: string[]; count: number }
  | { type: 'done'; takeoff: Takeoff }
  | { type: 'canceled' }
  | { type: 'error'; error: string };

/** Thrown by generateTakeoff when the user cancels the run. Callers should treat this
 *  as a clean stop (reset the UI) rather than a generation failure. */
export class TakeoffCanceledError extends Error {
  constructor() {
    super('Takeoff generation canceled.');
    this.name = 'TakeoffCanceledError';
  }
}

export interface TakeoffStreamHandlers {
  /** Fired on each progress milestone. */
  onPhase?: (phase: TakeoffPhase) => void;
  /** Fired while the structured takeoff compiles, with trades captured so far. */
  onProgress?: (trades: string[], count: number) => void;
}

/** Calls the generate-takeoff endpoint via streaming NDJSON.
 *  Calls onToken with the accumulated narration as each chunk arrives, and the
 *  optional handlers as phase/progress events stream in. */
export async function generateTakeoff(
  planId: string,
  trades?: string[],
  onToken?: (accumulated: string) => void,
  handlers?: TakeoffStreamHandlers,
): Promise<Takeoff> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${apiUrl}/generate-takeoff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token ?? supabaseKey}`,
    },
    body: JSON.stringify({ plan_id: planId, trades }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue; // heartbeat
      const event = JSON.parse(line) as TakeoffStreamEvent;
      if (event.type === 'token') {
        accumulated += event.text;
        onToken?.(accumulated);
      } else if (event.type === 'phase') {
        handlers?.onPhase?.(event.phase);
      } else if (event.type === 'progress') {
        handlers?.onProgress?.(event.trades, event.count);
      } else if (event.type === 'done') {
        return event.takeoff;
      } else if (event.type === 'canceled') {
        throw new TakeoffCanceledError();
      } else if (event.type === 'error') {
        const msg = event.error.toLowerCase().includes('timeout')
          ? 'The request timed out — this can happen for large plans. Please try again.'
          : event.error;
        throw new Error(msg);
      }
    }
  }
  throw new Error('Takeoff generation failed.');
}

/** Requests cancellation of the in-progress takeoff generation for a plan. The running
 *  server stream polls for this and stops; the live generateTakeoff call then rejects
 *  with TakeoffCanceledError (or, for a reattached run, the job row flips to 'canceled'). */
export async function cancelTakeoff(planId: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${apiUrl}/cancel-takeoff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token ?? supabaseKey}`,
    },
    body: JSON.stringify({ plan_id: planId }),
  });
  if (!res.ok) throw new Error('Failed to cancel takeoff.');
}

/** Cancels every in-progress takeoff for the current user. Used by the multi-plan
 *  questionnaire flow, which generates across all plans and has no single plan id. */
export async function cancelAllActiveTakeoffs(): Promise<void> {
  const jobs = await getActiveTakeoffJobs();
  const planIds = [...new Set(jobs.map((j) => j.plan_id))];
  await Promise.all(planIds.map((id) => cancelTakeoff(id)));
}

export interface ClarificationInput {
  gap: string;
  clarification: string;
}

export interface ClarifyResult {
  updatedSections: TakeoffSection[];
  resolvedGaps: string[];
}

const CLARIFY_TAKEOFF = gql`
  mutation ClarifyTakeoff($takeoffId: ID!, $clarifications: [ClarificationInput!]!) {
    clarifyTakeoff(takeoffId: $takeoffId, clarifications: $clarifications) {
      updatedSections
      resolvedGaps
    }
  }
`;

/** Sends a batch of gap clarifications and gets back updated sections. */
export async function clarifyTakeoff(
  takeoffId: string,
  clarifications: ClarificationInput[],
): Promise<ClarifyResult> {
  try {
    const { data } = await apolloClient.mutate<{ clarifyTakeoff: ClarifyResult }>({
      mutation: CLARIFY_TAKEOFF,
      variables: { takeoffId, clarifications },
      context: await authContext(),
    });
    return data!.clarifyTakeoff;
  } catch (error) {
    throw new Error(gqlErrorMessage(error, 'Clarification failed.'));
  }
}

/** Persists the selected materials trades onto the takeoff's data object. Returns the updated data. */
export async function saveMaterialsList(
  takeoffId: string,
  selectedTrades: string[],
): Promise<TakeoffData> {
  const { data: row, error: fetchError } = await supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw fetchError ?? new Error('Takeoff not found');

  const updatedData: TakeoffData = {
    ...(row.data as TakeoffData),
    materialsSelectedTrades: selectedTrades,
  };

  const { data: saved, error } = await supabase
    .from('takeoffs')
    .update({ data: updatedData })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error) throw error;
  if (!saved) throw new Error('Materials list save returned no data');

  return saved.data as TakeoffData;
}

/** Persists quantity overrides for the materials list. Returns the updated data. */
export async function saveMaterialsOverrides(
  takeoffId: string,
  overrides: Record<string, number>,
): Promise<TakeoffData> {
  const { data: row, error: fetchError } = await supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw fetchError ?? new Error('Takeoff not found');

  const updatedData: TakeoffData = {
    ...(row.data as TakeoffData),
    materialsQuantityOverrides: overrides,
  };

  const { data: saved, error } = await supabase
    .from('takeoffs')
    .update({ data: updatedData })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error) throw error;
  if (!saved) throw new Error('Materials overrides save returned no data');
  return saved.data as TakeoffData;
}

/** Persists bid pricing data onto the takeoff's data object. Returns the updated data. */
export async function saveBid(
  takeoffId: string,
  bid: BidData,
): Promise<TakeoffData> {
  const { data: row, error: fetchError } = await supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw fetchError ?? new Error('Takeoff not found');

  const updatedData: TakeoffData = {
    ...(row.data as TakeoffData),
    bid: { ...bid, updatedAt: new Date().toISOString() },
  };

  const { data: saved, error } = await supabase
    .from('takeoffs')
    .update({ data: updatedData })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error) throw error;
  if (!saved) throw new Error('Bid save returned no data');

  return saved.data as TakeoffData;
}

/** Stamps finalizedAt on the bid, locking it from further edits. */
export async function finalizeBid(takeoffId: string): Promise<TakeoffData> {
  const { data: row, error: fetchError } = await supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw fetchError ?? new Error('Takeoff not found');

  const existing = row.data as TakeoffData;
  const updatedData: TakeoffData = {
    ...existing,
    bid: { ...existing.bid!, finalizedAt: new Date().toISOString() },
  };

  const { data: saved, error } = await supabase
    .from('takeoffs')
    .update({ data: updatedData })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error) throw error;
  if (!saved) throw new Error('Finalize returned no data');

  return saved.data as TakeoffData;
}

/** Clears finalizedAt, reopening a finalized bid for edits. Refuses once the bid has
 *  been sent to the customer (that lock is permanent). */
export async function unfinalizeBid(takeoffId: string): Promise<TakeoffData> {
  const { data: row, error: fetchError } = await supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw fetchError ?? new Error('Takeoff not found');

  const existing = row.data as TakeoffData;
  if (!existing.bid?.finalizedAt) return existing; // already open — nothing to do
  if (existing.bid.sentAt) {
    throw new Error('This bid has been sent to the customer and can no longer be changed.');
  }
  const bid = { ...existing.bid, updatedAt: new Date().toISOString() };
  delete bid.finalizedAt;
  const updatedData: TakeoffData = { ...existing, bid };

  const { data: saved, error } = await supabase
    .from('takeoffs')
    .update({ data: updatedData })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error) throw error;
  if (!saved) throw new Error('Un-finalize returned no data');

  return saved.data as TakeoffData;
}

const SHARE_BID_PDF = gql`
  mutation ShareBidPdf($takeoffId: ID!, $email: String, $phone: String, $sharingMode: String) {
    shareBidPdf(takeoffId: $takeoffId, email: $email, phone: $phone, sharingMode: $sharingMode) {
      ok
    }
  }
`;

/** Sends the finalized bid as a PDF via email and/or SMS. */
export async function shareBidPdf(
  takeoffId: string,
  recipient: { email?: string; phone?: string },
  sharingMode: BidSharingMode = 'full',
): Promise<void> {
  try {
    await apolloClient.mutate({
      mutation: SHARE_BID_PDF,
      variables: { takeoffId, email: recipient.email, phone: recipient.phone, sharingMode },
      context: await authContext(),
    });
  } catch (error) {
    throw new Error(gqlErrorMessage(error, 'Share failed.'));
  }
}

/** Fetches all saved plans and generates a takeoff for each, scoped to the given trades. */
export async function performTakeoffs(trades: string[]): Promise<Takeoff[]> {
  const plans = await listHousePlans();
  return Promise.all(plans.map((plan) => generateTakeoff(plan.id, trades)));
}

const DEFAULT_PRICING_MATRIX: PricingMatrix = {
  unitDefaults: {},
  tradeOverrides: [],
};

export async function loadSettings(): Promise<UserSettings> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('pricing_matrix, trades, dismissed_notices, bid_sharing_mode')
    .maybeSingle();
  if (error) throw error;
  return {
    pricingMatrix: (data?.pricing_matrix as PricingMatrix) ?? DEFAULT_PRICING_MATRIX,
    trades: (data?.trades as string[]) ?? [],
    dismissedNotices: (data?.dismissed_notices as string[]) ?? [],
    bidSharingMode: (data?.bid_sharing_mode as BidSharingMode) ?? 'summary',
  };
}

/** Returns the number of subcontractor records linked to the current user's account. */
export async function getLinkedSubcontractorCount(): Promise<number> {
  const { count, error } = await supabase
    .from('subcontractors')
    .select('id', { count: 'exact', head: true })
    .not('linked_user_id', 'is', null)
    .eq('linked_user_id', (await supabase.auth.getUser()).data.user?.id ?? '');
  if (error) throw error;
  return count ?? 0;
}

/** Permanently dismisses a named notice for the current user. */
export async function dismissNotice(name: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data: current } = await supabase
    .from('user_settings')
    .select('dismissed_notices')
    .eq('user_id', user.id)
    .maybeSingle();
  const existing = (current?.dismissed_notices as string[]) ?? [];
  if (existing.includes(name)) return;
  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: user.id, dismissed_notices: [...existing, name] });
  if (error) throw error;
}

export interface LocalPricingItem {
  trade: string;
  description: string;
  unit: string;
}

const GET_LOCAL_PRICING = gql`
  mutation GetLocalPricing($zipCode: String!, $lineItems: [LocalPricingItemInput!]!, $takeoffId: ID) {
    getLocalPricing(zipCode: $zipCode, lineItems: $lineItems, takeoffId: $takeoffId)
  }
`;

/** Estimates local unit prices via GraphQL. Returns a bidKey → unit price map. */
export async function getLocalPricing(
  zipCode: string,
  lineItems: LocalPricingItem[],
  takeoffId?: string,
): Promise<Record<string, number>> {
  try {
    const { data } = await apolloClient.mutate<{ getLocalPricing: Record<string, number> }>({
      mutation: GET_LOCAL_PRICING,
      variables: { zipCode, lineItems, takeoffId },
      context: await authContext(),
    });
    return data!.getLocalPricing;
  } catch (error) {
    throw new Error(gqlErrorMessage(error, 'Local pricing failed.'));
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('user_settings')
    .upsert({
      user_id: user.id,
      pricing_matrix: settings.pricingMatrix,
      trades: settings.trades,
      bid_sharing_mode: settings.bidSharingMode,
    });
  if (error) throw error;
}

/** Signed URL for previewing a file in the private house-plans bucket. */
export async function getPlanSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(HOUSE_PLANS_BUCKET)
    .createSignedUrl(storagePath, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}

export async function uploadHousePlan(
  userId: string,
  file: File,
): Promise<HousePlan> {
  const safeName = file.name.replace(/[^\w.\-()+ ]/g, '_');
  const storagePath = `${userId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(HOUSE_PLANS_BUCKET)
    .upload(storagePath, file);
  if (uploadError) throw uploadError;

  const { data, error: insertError } = await supabase
    .from('house_plans')
    .insert({
      user_id: userId,
      file_name: file.name,
      storage_path: storagePath,
      file_size: file.size,
      content_type: file.type || null,
    })
    .select('id, file_name, storage_path, file_size, content_type, created_at')
    .single();
  if (insertError) throw insertError;
  return data;
}

// ── Subcontractors ────────────────────────────────────────────────────────────

export interface Subcontractor {
  id: string;
  name: string;
  trades: string[];
  contactEmail?: string;
  contactPhone?: string;
  contactAddress?: string;
  createdAt: string;
}

type SubcontractorRow = {
  id: string;
  name: string;
  trades: string[];
  contact_email: string | null;
  contact_phone: string | null;
  contact_address: string | null;
  created_at: string;
};

function rowToSub(row: SubcontractorRow): Subcontractor {
  return {
    id: row.id,
    name: row.name,
    trades: row.trades,
    contactEmail: row.contact_email ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    contactAddress: row.contact_address ?? undefined,
    createdAt: row.created_at,
  };
}

const SUB_COLUMNS = 'id, name, trades, contact_email, contact_phone, contact_address, created_at';

export async function listSubcontractors(): Promise<Subcontractor[]> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('subcontractors')
    .select(SUB_COLUMNS)
    // Exclude records where the current user IS the subcontractor — those are
    // entries created by other contractors and should not appear in their own list.
    .or(user ? `linked_user_id.is.null,linked_user_id.neq.${user.id}` : 'linked_user_id.is.null')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToSub);
}

export async function createSubcontractor(
  input: Omit<Subcontractor, 'id' | 'createdAt'>,
): Promise<Subcontractor> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data, error } = await supabase
    .from('subcontractors')
    .insert({
      user_id: user.id,
      name: input.name,
      trades: input.trades,
      contact_email: input.contactEmail ?? null,
      contact_phone: input.contactPhone ?? null,
      contact_address: input.contactAddress ?? null,
    })
    .select(SUB_COLUMNS)
    .single();
  if (error) throw error;
  return rowToSub(data);
}

export async function updateSubcontractor(
  id: string,
  input: Partial<Omit<Subcontractor, 'id' | 'createdAt'>>,
): Promise<Subcontractor> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.trades !== undefined) patch.trades = input.trades;
  if ('contactEmail' in input) patch.contact_email = input.contactEmail ?? null;
  if ('contactPhone' in input) patch.contact_phone = input.contactPhone ?? null;
  if ('contactAddress' in input) patch.contact_address = input.contactAddress ?? null;
  const { data, error } = await supabase
    .from('subcontractors')
    .update(patch)
    .eq('id', id)
    .select(SUB_COLUMNS)
    .single();
  if (error) throw error;
  return rowToSub(data);
}

export async function deleteSubcontractor(id: string): Promise<void> {
  const { error } = await supabase.from('subcontractors').delete().eq('id', id);
  if (error) throw error;
}

// ── Sub delegated work ────────────────────────────────────────────────────────

export interface DelegatedTakeoff extends Takeoff {
  /** Trades in this takeoff that have been delegated to the current user. */
  myDelegatedTrades: string[];
}

/** Returns the subcontractor record IDs that are linked to the current user. */
export async function getMyLinkedSubIds(): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('subcontractors')
    .select('id')
    .eq('linked_user_id', user.id);
  if (error) throw error;
  return (data ?? []).map((row) => row.id as string);
}

/** Returns all takeoffs (owned by other users) that have sections delegated to the current user. */
export async function getMyDelegatedTakeoffs(): Promise<DelegatedTakeoff[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const mySubIds = await getMyLinkedSubIds();
  if (mySubIds.length === 0) return [];
  const subIdSet = new Set(mySubIds);

  // RLS now allows subs to read delegated takeoffs; exclude own takeoffs.
  const { data, error } = await supabase
    .from('takeoffs')
    .select('id, plan_id, model, data, created_at')
    .neq('user_id', user.id)
    .eq('archived', false)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? [])
    .map((t) => {
      const delegations = (t.data as TakeoffData)?.bid?.delegations ?? {};
      const myDelegatedTrades = Object.entries(delegations)
        .filter(([, del]) => subIdSet.has(del.subId))
        .map(([trade]) => trade);
      return { ...(t as Takeoff), data: t.data as TakeoffData, myDelegatedTrades };
    })
    .filter((t) => t.myDelegatedTrades.length > 0);
}

const APPROVE_SUB_BID = gql`
  mutation ApproveSubBid($takeoffId: ID!, $trades: [String!]!) {
    approveSubBid(takeoffId: $takeoffId, trades: $trades) {
      ok
      approvedAt
    }
  }
`;

/** Formally approves the sub's bid, stamping approvedAt on each delegated trade. */
export async function approveSubBid(
  takeoffId: string,
  trades: string[],
): Promise<void> {
  try {
    await apolloClient.mutate({
      mutation: APPROVE_SUB_BID,
      variables: { takeoffId, trades },
      context: await authContext(),
    });
  } catch (error) {
    throw new Error(gqlErrorMessage(error, 'Approval failed.'));
  }
}

const SAVE_SUB_PRICES = gql`
  mutation SaveSubPrices($takeoffId: ID!, $delegations: JSON!) {
    saveSubPrices(takeoffId: $takeoffId, delegations: $delegations) {
      ok
    }
  }
`;

/** Writes a sub's unit prices back into the GC's takeoff delegation data. */
export async function saveSubPrices(
  takeoffId: string,
  delegations: Record<string, SubDelegationUpdate>,
): Promise<void> {
  try {
    await apolloClient.mutate({
      mutation: SAVE_SUB_PRICES,
      variables: { takeoffId, delegations },
      context: await authContext(),
    });
  } catch (error) {
    throw new Error(gqlErrorMessage(error, 'Save failed.'));
  }
}
