import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { confirmTopup, createCreditCheckout, getCreditBalanceCents } from '../lib/supabase';

const TOPUP_PRESETS_CENTS = [2500, 5000, 10000, 20000];

const fmtUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Fires after the balance changes so the header chip (and any listener) refetches. */
export function notifyCreditsChanged() {
  window.dispatchEvent(new Event('credits-updated'));
}

/** Header chip showing the live credit balance; navigates to the billing screen. */
export function CreditsChip() {
  const navigate = useNavigate();
  const [cents, setCents] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getCreditBalanceCents()
        .then((c) => active && setCents(c))
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('credits-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('credits-updated', refresh);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => navigate('/billing')}
      className="rounded-lg px-3 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
      title="Credit balance"
    >
      {cents == null ? '— credits' : `${fmtUsd(cents)} credits`}
    </button>
  );
}

export function BillingScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'canceled' | 'error'; text: string } | null>(null);

  // On return from Stripe Checkout: confirm the session (credits the balance) or note a cancel.
  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    const canceled = searchParams.get('canceled');
    if (sessionId) {
      confirmTopup(sessionId)
        .then((cents) => {
          setBalanceCents(cents);
          notifyCreditsChanged();
          setNotice({ kind: 'success', text: 'Payment received — your credits have been added.' });
        })
        .catch((err) => setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not confirm payment.' }))
        .finally(() => navigate('/billing', { replace: true }));
    } else if (canceled) {
      setNotice({ kind: 'canceled', text: 'Checkout canceled — no charge was made.' });
      navigate('/billing', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getCreditBalanceCents().then(setBalanceCents).catch(() => setBalanceCents(0));
  }, []);

  const handleTopUp = async (amountCents: number) => {
    setStarting(amountCents);
    try {
      const url = await createCreditCheckout(amountCents);
      window.location.href = url; // hand off to Stripe-hosted Checkout
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start checkout.' });
      setStarting(null);
    }
  };

  const noticeStyles = {
    success: 'border-green-200 bg-green-50 text-green-800',
    canceled: 'border-slate-200 bg-slate-50 text-slate-600',
    error: 'border-red-200 bg-red-50 text-red-700',
  } as const;

  return (
    <section className="mt-10 w-full max-w-xl">
      <h1 className="text-xl font-semibold text-slate-800">Credits</h1>
      <p className="mt-1 text-sm text-slate-500">
        Prepay for credits, then generate takeoffs for free. Once a takeoff is generated,
        unlocking pricing, materials, and the final bid costs{' '}
        <span className="font-medium text-slate-700">$0.05 per square foot</span> of the
        plan (minimum <span className="font-medium text-slate-700">$15</span>) — charged
        once per project.
      </p>

      {notice && (
        <div className={`mt-5 rounded-xl border px-4 py-3 text-sm ${noticeStyles[notice.kind]}`}>
          {notice.text}
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Balance</p>
        <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">
          {balanceCents == null ? '—' : fmtUsd(balanceCents)}
        </p>

        <p className="mt-6 text-sm font-medium text-slate-700">Add credits</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TOPUP_PRESETS_CENTS.map((amount) => (
            <button
              key={amount}
              type="button"
              onClick={() => handleTopUp(amount)}
              disabled={starting !== null}
              className="rounded-xl border-2 border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50"
            >
              {starting === amount ? 'Redirecting…' : fmtUsd(amount)}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">Secure payment via Stripe. Test mode.</p>
      </div>
    </section>
  );
}
