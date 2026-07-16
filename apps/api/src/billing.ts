// Shared credit-wallet helpers used by both the GraphQL resolvers and the Stripe webhook.
// All writes go through the service-role client; idempotency is enforced by unique indexes
// on credit_transactions (stripe_session_id for top-ups, takeoff_id for charges,
// stripe_payment_intent_id for auto top-ups). Company-scoped throughout (decision 2: one
// Stripe customer, one saved card, one credit balance, one subscription per company).
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from './lib/stripe';

const UNIQUE_VIOLATION = '23505';

/** Current credit balance (cents) for a company. */
export async function getBalanceCents(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { data, error } = await supabase
    .from('company_credit_balance')
    .select('balance_cents')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data?.balance_cents ?? 0;
}

/**
 * True once a takeoff is unlocked for Materials/Pricing/Bid: either it was already charged (a
 * `charge` row exists, via payForTakeoff) or the takeoff's company currently has an active
 * monthly plan. Company-scoped rather than caller-scoped so this stays correct when a delegated
 * subcontractor (not the GC) is the one calling a paid-gated resolver.
 */
export async function isTakeoffPaid(supabase: SupabaseClient, takeoffId: string): Promise<boolean> {
  const { data: charge, error: chargeError } = await supabase
    .from('credit_transactions')
    .select('id')
    .eq('takeoff_id', takeoffId)
    .eq('kind', 'charge')
    .maybeSingle();
  if (chargeError) throw chargeError;
  if (charge) return true;

  const { data: takeoff, error: takeoffError } = await supabase
    .from('takeoffs')
    .select('company_id')
    .eq('id', takeoffId)
    .maybeSingle();
  if (takeoffError) throw takeoffError;
  if (!takeoff) return false;

  return hasActiveMonthlySubscription(await getBillingCustomer(supabase, takeoff.company_id));
}

/** Idempotently credit a paid Stripe Checkout session to the company's balance. Safe to call
 *  from both the webhook and the confirm-on-return mutation — the second call no-ops. */
export async function creditTopup(
  supabase: SupabaseClient,
  opts: { companyId: string; actorUserId: string; sessionId: string; amountCents: number },
): Promise<void> {
  const { error } = await supabase.from('credit_transactions').insert({
    company_id: opts.companyId,
    actor_user_id: opts.actorUserId,
    kind: 'topup',
    amount_cents: opts.amountCents,
    stripe_session_id: opts.sessionId,
  });
  // Unique violation on stripe_session_id → already credited; treat as success.
  if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
}

// ── Saved card / auto top-up ──────────────────────────────────────────────────

export interface BillingCustomer {
  stripeCustomerId: string;
  stripePaymentMethodId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  autoTopupEnabled: boolean;
  autoTopupThresholdCents: number | null;
  autoTopupTargetCents: number | null;
  autoTopupDisabledReason: string | null;
  plan: 'per_bid' | 'monthly';
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionCurrentPeriodEnd: string | null;
}

/** True when the customer's monthly plan currently covers bids without a per-bid charge. */
export function hasActiveMonthlySubscription(customer: BillingCustomer | null): boolean {
  return (
    customer?.plan === 'monthly' &&
    (customer.subscriptionStatus === 'active' || customer.subscriptionStatus === 'trialing')
  );
}

export async function getBillingCustomer(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BillingCustomer | null> {
  const { data, error } = await supabase
    .from('billing_customers')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    stripeCustomerId: data.stripe_customer_id,
    stripePaymentMethodId: data.stripe_payment_method_id,
    cardBrand: data.card_brand,
    cardLast4: data.card_last4,
    autoTopupEnabled: data.auto_topup_enabled,
    autoTopupThresholdCents: data.auto_topup_threshold_cents,
    autoTopupTargetCents: data.auto_topup_target_cents,
    autoTopupDisabledReason: data.auto_topup_disabled_reason,
    plan: data.plan,
    stripeSubscriptionId: data.stripe_subscription_id,
    subscriptionStatus: data.subscription_status,
    subscriptionCancelAtPeriodEnd: data.subscription_cancel_at_period_end,
    subscriptionCurrentPeriodEnd: data.subscription_current_period_end,
  };
}

/** Returns the company's Stripe Customer ID, creating one (and the billing_customers row) on
 *  first use. Prefers companies.billing_email (set at company creation) over the acting
 *  member's own email, since the Stripe customer belongs to the company, not one person. */
export async function ensureStripeCustomerId(
  supabase: SupabaseClient,
  companyId: string,
  actorUserId: string,
  fallbackEmail: string | undefined,
): Promise<string> {
  const existing = await getBillingCustomer(supabase, companyId);
  if (existing) return existing.stripeCustomerId;

  const { data: company } = await supabase
    .from('companies')
    .select('billing_email')
    .eq('id', companyId)
    .maybeSingle();
  const email = company?.billing_email ?? fallbackEmail;

  const customer = await getStripe().customers.create({ email, metadata: { companyId } });
  const { error } = await supabase
    .from('billing_customers')
    .insert({ company_id: companyId, created_by_user_id: actorUserId, stripe_customer_id: customer.id });
  if (error) throw error;
  return customer.id;
}

/** The SetupIntent fields persistCardFromSetupIntent reads (avoids fighting the Stripe SDK's namespaced types). */
interface SetupIntentLike {
  payment_method: string | { id: string } | null;
  customer: string | { id: string } | null;
}

/** Persists the payment method a completed SetupIntent attached, and makes it the customer's default. */
export async function persistCardFromSetupIntent(
  supabase: SupabaseClient,
  companyId: string,
  setupIntent: SetupIntentLike,
): Promise<void> {
  const paymentMethodId =
    typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
  if (!paymentMethodId) return;

  const pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  const { error } = await supabase
    .from('billing_customers')
    .update({
      stripe_payment_method_id: paymentMethodId,
      card_brand: pm.card?.brand ?? null,
      card_last4: pm.card?.last4 ?? null,
      auto_topup_disabled_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
  if (error) throw error;

  const customerId =
    typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  if (customerId) {
    await getStripe().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }
}

export async function setAutoTopup(
  supabase: SupabaseClient,
  companyId: string,
  opts: { enabled: boolean; thresholdCents: number | null; targetCents: number | null },
): Promise<void> {
  const { error } = await supabase
    .from('billing_customers')
    .update({
      auto_topup_enabled: opts.enabled,
      auto_topup_threshold_cents: opts.thresholdCents,
      auto_topup_target_cents: opts.targetCents,
      auto_topup_disabled_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
  if (error) throw error;
}

export async function disableAutoTopup(
  supabase: SupabaseClient,
  companyId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from('billing_customers')
    .update({ auto_topup_enabled: false, auto_topup_disabled_reason: reason, updated_at: new Date().toISOString() })
    .eq('company_id', companyId);
  if (error) throw error;
}

export async function removeSavedCard(supabase: SupabaseClient, companyId: string): Promise<void> {
  const { error } = await supabase
    .from('billing_customers')
    .update({
      stripe_payment_method_id: null,
      card_brand: null,
      card_last4: null,
      auto_topup_enabled: false,
      auto_topup_disabled_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
  if (error) throw error;
}

// ── Monthly plan / subscription ──────────────────────────────────────────────

/**
 * The Stripe Subscription fields syncSubscriptionFromStripe reads, kept as a minimal structural
 * type (rather than importing Stripe.Subscription) so both the real SDK object and the webhook's
 * raw event payload satisfy it without a cast. `current_period_end` lives on the subscription's
 * line item, not the subscription itself, as of the API version this SDK targets.
 */
export interface StripeSubscriptionLike {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  items: { data: { current_period_end: number }[] };
}

/**
 * Idempotently syncs a Stripe Subscription onto billing_customers. Called from both the
 * confirm-on-return mutation and the webhook (checkout.session.completed, subscription.updated,
 * subscription.deleted) — always the single source of truth for `plan`, so it can only ever be
 * 'monthly' when Stripe currently reports the subscription active/trialing.
 */
export async function syncSubscriptionFromStripe(
  supabase: SupabaseClient,
  companyId: string,
  subscription: StripeSubscriptionLike,
): Promise<void> {
  const active = subscription.status === 'active' || subscription.status === 'trialing';
  const periodEnd = subscription.items.data[0]?.current_period_end;
  const { error } = await supabase
    .from('billing_customers')
    .update({
      plan: active ? 'monthly' : 'per_bid',
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,
      subscription_cancel_at_period_end: subscription.cancel_at_period_end,
      subscription_current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId);
  if (error) throw error;
}

/**
 * Sweeps 100% of the company's current internal credit balance into Stripe's native Customer
 * Balance, which Stripe automatically applies to reduce the amount due on this customer's
 * next (and subsequent) invoices — including recurring subscription invoices — before
 * charging the default payment method. Manual, full-balance-only, owner-initiated (there is
 * no automatic sweep at plan-switch or topup time). Re-reads the balance fresh at call time so
 * a second call after a successful sweep sees 0 and rejects, rather than double-sweeping stale
 * client state.
 *
 * Deliberately does NOT swallow errors (unlike runAutoTopupIfNeeded) — this is a user-initiated
 * action the resolver must surface, not opportunistic background reconciliation.
 */
export async function applyBalanceToSubscription(
  supabase: SupabaseClient,
  opts: { companyId: string; actorUserId: string },
): Promise<{ appliedCents: number }> {
  const { companyId, actorUserId } = opts;

  const customer = await getBillingCustomer(supabase, companyId);
  if (!hasActiveMonthlySubscription(customer)) {
    throw new Error('Applying your balance requires an active monthly subscription.');
  }

  const balanceCents = await getBalanceCents(supabase, companyId);
  if (balanceCents <= 0) throw new Error('There is no balance to apply.');

  const balanceTransaction = await getStripe().customers.createBalanceTransaction(customer!.stripeCustomerId, {
    amount: -balanceCents,
    currency: 'usd',
    description: `Bid Wise: applied existing credit balance to monthly subscription (company ${companyId})`,
    metadata: { companyId, kind: 'applied_to_subscription' },
  });

  const { error } = await supabase.from('credit_transactions').insert({
    company_id: companyId,
    actor_user_id: actorUserId,
    kind: 'applied_to_subscription',
    amount_cents: -balanceCents,
  });
  if (error) {
    // Stripe already granted the credit — a retry would sweep the same money into Stripe a
    // second time (a real double-credit, not just a UI glitch). Fail loud rather than
    // silently retrying; needs manual reconciliation if this ever hits.
    console.error(
      `[applyBalanceToSubscription] Stripe balance transaction ${balanceTransaction.id} succeeded for ` +
        `company ${companyId} but the internal ledger insert failed — needs manual reconciliation:`,
      error,
    );
    throw new Error(
      'Your balance was applied on Stripe but we could not record it. Do not try again — contact support.',
    );
  }

  return { appliedCents: balanceCents };
}

async function creditAutoTopup(
  supabase: SupabaseClient,
  opts: { companyId: string; paymentIntentId: string; amountCents: number },
): Promise<void> {
  const { error } = await supabase.from('credit_transactions').insert({
    company_id: opts.companyId,
    kind: 'topup',
    amount_cents: opts.amountCents,
    stripe_payment_intent_id: opts.paymentIntentId,
  });
  if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
}

/**
 * Checks the company's balance against its configured auto top-up threshold and, if it has
 * dropped below it, charges the saved card off-session to bring it back up to the target.
 * Never throws — a declined/failed charge just disables auto top-up with a reason the billing
 * screen can surface, so callers (e.g. payForTakeoff) can call this opportunistically without
 * risking the primary flow.
 */
export async function runAutoTopupIfNeeded(supabase: SupabaseClient, companyId: string): Promise<void> {
  const customer = await getBillingCustomer(supabase, companyId);
  if (!customer?.autoTopupEnabled || !customer.stripePaymentMethodId) return;
  if (!customer.autoTopupThresholdCents || !customer.autoTopupTargetCents) return;

  const balance = await getBalanceCents(supabase, companyId);
  if (balance >= customer.autoTopupThresholdCents) return;

  const amountCents = customer.autoTopupTargetCents - balance;
  if (amountCents <= 0) return;

  try {
    const intent = await getStripe().paymentIntents.create({
      customer: customer.stripeCustomerId,
      payment_method: customer.stripePaymentMethodId,
      amount: amountCents,
      currency: 'usd',
      off_session: true,
      confirm: true,
      metadata: { companyId, kind: 'auto_topup' },
    });
    if (intent.status === 'succeeded') {
      await creditAutoTopup(supabase, { companyId, paymentIntentId: intent.id, amountCents });
    } else {
      await disableAutoTopup(supabase, companyId, 'Automatic top-up could not be completed — please check your card.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Card was declined.';
    await disableAutoTopup(supabase, companyId, message);
  }
}
