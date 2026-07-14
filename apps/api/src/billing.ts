// Shared credit-wallet helpers used by both the GraphQL resolvers and the Stripe webhook.
// All writes go through the service-role client; idempotency is enforced by unique indexes
// on credit_transactions (stripe_session_id for top-ups, takeoff_id for charges).
import type { SupabaseClient } from '@supabase/supabase-js';

const UNIQUE_VIOLATION = '23505';

/** Current credit balance (cents) for a user. */
export async function getBalanceCents(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('user_credit_balance')
    .select('balance_cents')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.balance_cents ?? 0;
}

/** True once a takeoff has been paid for (a `charge` row exists) via payForTakeoff. */
export async function isTakeoffPaid(supabase: SupabaseClient, takeoffId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('credit_transactions')
    .select('id')
    .eq('takeoff_id', takeoffId)
    .eq('kind', 'charge')
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Idempotently credit a paid Stripe Checkout session to the user's balance. Safe to call
 *  from both the webhook and the confirm-on-return mutation — the second call no-ops. */
export async function creditTopup(
  supabase: SupabaseClient,
  opts: { userId: string; sessionId: string; amountCents: number },
): Promise<void> {
  const { error } = await supabase.from('credit_transactions').insert({
    user_id: opts.userId,
    kind: 'topup',
    amount_cents: opts.amountCents,
    stripe_session_id: opts.sessionId,
  });
  // Unique violation on stripe_session_id → already credited; treat as success.
  if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
}
