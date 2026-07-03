import Stripe from 'stripe';

type StripeClient = InstanceType<typeof Stripe>;

let client: StripeClient | null = null;

/** Lazily constructs a shared Stripe client. Throws if the key is missing. */
export function getStripe(): StripeClient {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY not set.');
  if (!client) client = new Stripe(apiKey);
  return client;
}

/** Base URL the Checkout success/cancel redirects point back to. */
export function appUrl(): string {
  return (
    process.env.APP_URL ??
    process.env.CORS_ALLOWED_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:4200'
  );
}
