// Stripe webhook: the source of truth for completed credit top-ups. Mounted with a RAW
// body parser (signature verification needs the unmodified bytes). The confirm-on-return
// GraphQL mutation credits the same session idempotently, so top-ups still work locally
// before STRIPE_WEBHOOK_SECRET is wired up — this just makes it robust if the tab closes.
import type { Request, Response } from 'express';
import { getStripe } from './lib/stripe';
import { supabaseAdmin } from './lib/supabase-admin';
import { creditTopup } from './billing';

/** The Checkout session fields this handler reads. */
interface TopupSession {
  id: string;
  metadata?: Record<string, string> | null;
  payment_status?: string | null;
  amount_total?: number | null;
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
      const userId = session.metadata?.userId;
      if (
        session.metadata?.kind === 'credit_topup' &&
        userId &&
        session.payment_status === 'paid'
      ) {
        await creditTopup(supabaseAdmin, {
          userId,
          sessionId: session.id,
          amountCents: session.amount_total ?? 0,
        });
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    res.status(500).send('handler error');
    return;
  }

  res.json({ received: true });
}
