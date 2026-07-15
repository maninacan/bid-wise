import type { SupabaseClient } from '@supabase/supabase-js';

export interface UsageRecord {
  user_id: string;
  /** Which company this usage should be attributed to. Falls back to the acting user's
   *  first-joined company (via a DB trigger) when omitted — pass it explicitly wherever
   *  the takeoff/plan's own company_id is already known, since a user may belong to more
   *  than one company. */
  company_id?: string | null;
  plan_id?: string | null;
  takeoff_id?: string | null;
  operation: 'generate-takeoff' | 'clarify-takeoff' | 'recalculate-materials' | 'get-local-pricing';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export async function trackUsage(
  supabase: SupabaseClient,
  record: UsageRecord,
): Promise<void> {
  const { error } = await supabase.from('ai_usage').insert({
    user_id: record.user_id,
    company_id: record.company_id ?? null,
    plan_id: record.plan_id ?? null,
    takeoff_id: record.takeoff_id ?? null,
    operation: record.operation,
    model: record.model,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_creation_input_tokens: record.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: record.cache_read_input_tokens ?? 0,
  });
  if (error) {
    console.error('[track-usage] failed to insert ai_usage:', error.message);
  }
}
