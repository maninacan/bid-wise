// Stripe webhook: the source of truth for completed credit top-ups. Mounted with a RAW
// body parser (signature verification needs the unmodified bytes). The confirm-on-return
// GraphQL mutation credits the same session idempotently, so top-ups still work locally
// before STRIPE_WEBHOOK_SECRET is wired up — this just makes it robust if the tab closes.
import type { Request, Response } from 'express';
import { getStripe } from './lib/stripe';
import { supabaseAdmin } from './lib/supabase-admin';
import { creditTopup, persistCardFromSetupIntent, syncSubscriptionFromStripe, type StripeSubscriptionLike } from './billing';

/** The Checkout session fields this handler reads. */
interface TopupSession {
  id: string;
  metadata?: Record<string, string> | null;
  payment_status?: string | null;
  amount_total?: number | null;
}

/** The Subscription fields this handler reads off a subscription.updated/deleted event
 *  (metadata carries companyId, set at checkout creation via subscription_data.metadata). */
interface SubscriptionEventObject extends StripeSubscriptionLike {
  metadata?: Record<string, string> | null;
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — ignoring webhook.');
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  const sig = req.headers['stripe-signature'];
  // event is inferred as Stripe.Event from constructEvent's return type.
  let event;
  try {
    // req.body is a Buffer here (express.raw). Verify against the raw bytes.
    event = getStripe().webhooks.constructEvent(req.body, sig as string, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err);
    res.status(400).send('invalid signature');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as unknown as TopupSession;
      const companyId = session.metadata?.companyId;
      const actorUserId = session.metadata?.actorUserId;
      if (
        session.metadata?.kind === 'credit_topup' &&
        companyId &&
        actorUserId &&
        session.payment_status === 'paid'
      ) {
        await creditTopup(supabaseAdmin, {
          companyId,
          actorUserId,
          sessionId: session.id,
          amountCents: session.amount_total ?? 0,
        });
      } else if (session.metadata?.kind === 'card_setup' && companyId) {
        // Backup path in case the browser never returns to confirmCardSetup after redirect.
        const full = await getStripe().checkout.sessions.retrieve(session.id, { expand: ['setup_intent'] });
        if (full.setup_intent && typeof full.setup_intent !== 'string') {
          await persistCardFromSetupIntent(supabaseAdmin, companyId, full.setup_intent);
        }
      } else if (session.metadata?.kind === 'subscription' && companyId) {
        // Backup path in case the browser never returns to confirmSubscriptionCheckout after redirect.
        const full = await getStripe().checkout.sessions.retrieve(session.id, { expand: ['subscription'] });
        if (full.subscription && typeof full.subscription !== 'string') {
          await syncSubscriptionFromStripe(supabaseAdmin, companyId, full.subscription);
        }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as unknown as SubscriptionEventObject;
      const companyId = subscription.metadata?.companyId;
      if (companyId) {
        await syncSubscriptionFromStripe(supabaseAdmin, companyId, subscription);
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    res.status(500).send('handler error');
    return;
  }

  res.json({ received: true });
}
