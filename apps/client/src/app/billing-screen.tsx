import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  cancelSubscription,
  confirmCardSetup,
  confirmSubscriptionCheckout,
  confirmTopup,
  createCreditCheckout,
  createSubscriptionCheckout,
  getBillingSettings,
  getCreditBalanceCents,
  getStripeTestMode,
  removeSavedCard,
  resumeSubscription,
  startCardSetup,
  updateAutoTopup,
  type BillingSettings,
} from '../lib/supabase';
import { useCompany } from '../lib/company-context';

const TOPUP_PRESETS_CENTS = [2500, 5000, 10000, 20000, 50000, 100000];

// Must match MIN_TOPUP_CENTS / MAX_TOPUP_CENTS in apps/api/src/graphql/resolvers.ts.
const MIN_TOPUP_CENTS = 500;
const MAX_TOPUP_CENTS = 100_000;

const fmtUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const centsToDollarInput = (cents: number | null) => (cents == null ? '' : String(cents / 100));

/** Fires after the balance changes so the header chip (and any listener) refetches. */
export function notifyCreditsChanged() {
  window.dispatchEvent(new Event('credits-updated'));
}

/** Header chip showing the live credit balance (shared company wallet); navigates to the billing screen. */
export function CreditsChip() {
  const navigate = useNavigate();
  const { activeCompanyId } = useCompany();
  const [cents, setCents] = useState<number | null>(null);

  useEffect(() => {
    if (!activeCompanyId) return;
    let active = true;
    const refresh = () => {
      getCreditBalanceCents(activeCompanyId)
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
  }, [activeCompanyId]);

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
  const { activeCompanyId, activeCompany } = useCompany();
  const isOwner = activeCompany?.role === 'owner';
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'canceled' | 'error'; text: string } | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [customAmountError, setCustomAmountError] = useState<string | null>(null);

  const [billing, setBilling] = useState<BillingSettings | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [thresholdInput, setThresholdInput] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [autoTopupError, setAutoTopupError] = useState<string | null>(null);
  const [savingAutoTopup, setSavingAutoTopup] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const applyBillingSettings = (settings: BillingSettings) => {
    setBilling(settings);
    setAutoEnabled(settings.autoTopupEnabled);
    setThresholdInput(centsToDollarInput(settings.autoTopupThresholdCents));
    setTargetInput(centsToDollarInput(settings.autoTopupTargetCents));
  };

  // On return from Stripe Checkout: confirm the session (credits the balance) or note a cancel.
  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    const canceled = searchParams.get('canceled');
    if (sessionId && activeCompanyId) {
      confirmTopup(sessionId, activeCompanyId)
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

  // On return from Stripe Checkout (setup mode): confirm the session and save the card.
  useEffect(() => {
    const setupSessionId = searchParams.get('setup_session_id');
    const setupCanceled = searchParams.get('setup_canceled');
    if (setupSessionId && activeCompanyId) {
      confirmCardSetup(setupSessionId, activeCompanyId)
        .then((settings) => {
          applyBillingSettings(settings);
          setNotice({ kind: 'success', text: 'Card saved.' });
        })
        .catch((err) => setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save card.' }))
        .finally(() => navigate('/billing', { replace: true }));
    } else if (setupCanceled) {
      setNotice({ kind: 'canceled', text: 'Card setup canceled.' });
      navigate('/billing', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On return from Stripe Checkout (subscription mode): confirm the session and sync the plan.
  useEffect(() => {
    const subSessionId = searchParams.get('sub_session_id');
    const subCanceled = searchParams.get('sub_canceled');
    if (subSessionId && activeCompanyId) {
      confirmSubscriptionCheckout(subSessionId, activeCompanyId)
        .then((settings) => {
          applyBillingSettings(settings);
          setNotice({ kind: 'success', text: 'You’re on the monthly plan — bids are unlocked with no per-bid charge.' });
        })
        .catch((err) => setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not confirm subscription.' }))
        .finally(() => navigate('/billing', { replace: true }));
    } else if (subCanceled) {
      setNotice({ kind: 'canceled', text: 'Checkout canceled — you’re still on pay-per-bid.' });
      navigate('/billing', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeCompanyId) return;
    getCreditBalanceCents(activeCompanyId).then(setBalanceCents).catch(() => setBalanceCents(0));
  }, [activeCompanyId]);

  useEffect(() => {
    getStripeTestMode().then(setTestMode).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeCompanyId) return;
    getBillingSettings(activeCompanyId).then(applyBillingSettings).catch(() => {});
  }, [activeCompanyId]);

  const handleTopUp = async (amountCents: number) => {
    if (!activeCompanyId) return;
    setStarting(amountCents);
    try {
      const url = await createCreditCheckout(amountCents, activeCompanyId);
      window.location.href = url; // hand off to Stripe-hosted Checkout
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start checkout.' });
      setStarting(null);
    }
  };

  const handleCustomTopUp = () => {
    setCustomAmountError(null);
    const dollars = parseFloat(customAmount);
    if (!Number.isFinite(dollars)) {
      setCustomAmountError('Enter an amount.');
      return;
    }
    const cents = Math.round(dollars * 100);
    if (cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS) {
      setCustomAmountError(`Enter an amount between $${MIN_TOPUP_CENTS / 100} and $${MAX_TOPUP_CENTS / 100}.`);
      return;
    }
    handleTopUp(cents);
  };

  const handleAddCard = async () => {
    if (!activeCompanyId) return;
    setCardBusy(true);
    try {
      const url = await startCardSetup(activeCompanyId);
      window.location.href = url;
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start card setup.' });
      setCardBusy(false);
    }
  };

  const handleRemoveCard = async () => {
    if (!activeCompanyId) return;
    setCardBusy(true);
    try {
      applyBillingSettings(await removeSavedCard(activeCompanyId));
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not remove card.' });
    } finally {
      setCardBusy(false);
    }
  };

  const handleSaveAutoTopup = async () => {
    if (!activeCompanyId) return;
    setAutoTopupError(null);
    let thresholdCents: number | undefined;
    let targetCents: number | undefined;
    if (autoEnabled) {
      const thresholdDollars = parseFloat(thresholdInput);
      const targetDollars = parseFloat(targetInput);
      if (!Number.isFinite(thresholdDollars) || !Number.isFinite(targetDollars)) {
        setAutoTopupError('Enter valid dollar amounts.');
        return;
      }
      thresholdCents = Math.round(thresholdDollars * 100);
      targetCents = Math.round(targetDollars * 100);
      if (targetCents <= thresholdCents) {
        setAutoTopupError('Top-up amount must be greater than the minimum balance.');
        return;
      }
    }
    setSavingAutoTopup(true);
    try {
      applyBillingSettings(await updateAutoTopup(autoEnabled, thresholdCents, targetCents, activeCompanyId));
      setNotice({ kind: 'success', text: autoEnabled ? 'Auto top-up enabled.' : 'Auto top-up disabled.' });
    } catch (err) {
      setAutoTopupError(err instanceof Error ? err.message : 'Could not update auto top-up.');
    } finally {
      setSavingAutoTopup(false);
    }
  };

  const handleSwitchToMonthly = async () => {
    if (!activeCompanyId) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const url = await createSubscriptionCheckout(activeCompanyId);
      window.location.href = url; // hand off to Stripe-hosted Checkout
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not start checkout.');
      setPlanBusy(false);
    }
  };

  const handleCancelPlan = async () => {
    if (!activeCompanyId) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      applyBillingSettings(await cancelSubscription(activeCompanyId));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not cancel plan.');
    } finally {
      setPlanBusy(false);
    }
  };

  const handleResumePlan = async () => {
    if (!activeCompanyId) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      applyBillingSettings(await resumeSubscription(activeCompanyId));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not resume plan.');
    } finally {
      setPlanBusy(false);
    }
  };

  const noticeStyles = {
    success: 'border-green-200 bg-green-50 text-green-800',
    canceled: 'border-slate-200 bg-slate-50 text-slate-600',
    error: 'border-red-200 bg-red-50 text-red-700',
  } as const;

  const isMonthly = billing?.plan === 'monthly';
  const renewalDate = billing?.subscriptionCurrentPeriodEnd
    ? new Date(billing.subscriptionCurrentPeriodEnd).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <section className="mt-10 w-full max-w-xl">
      <h1 className="text-xl font-semibold text-slate-800">Billing</h1>
      <p className="mt-1 text-sm text-slate-500">
        Choose how you pay for takeoffs — meter every bid, or go flat-rate for unlimited bids.
      </p>

      {notice && (
        <div className={`mt-5 rounded-xl border px-4 py-3 text-sm ${noticeStyles[notice.kind]}`}>
          {notice.text}
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Plan</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div
            className={`rounded-xl border-2 p-4 ${
              !isMonthly ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-800">Pay per bid</p>
              {!isMonthly && (
                <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  Current plan
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              <span className="font-medium text-slate-700">$0.05/sq ft</span>, $15 minimum —
              charged once per project when you unlock Materials, Pricing, and the Bid.
            </p>
          </div>

          <div
            className={`rounded-xl border-2 p-4 ${
              isMonthly ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-800">Monthly unlimited</p>
              {isMonthly && (
                <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  Current plan
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              <span className="font-medium text-slate-700">
                {billing ? fmtUsd(billing.monthlyPlanPriceCents) : '—'}/mo
              </span>{' '}
              — unlimited bids, any size, no per-bid charge.
            </p>

            {!isMonthly && isOwner && (
              <button
                type="button"
                onClick={handleSwitchToMonthly}
                disabled={planBusy}
                className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:opacity-50"
              >
                {planBusy ? 'Redirecting…' : 'Switch to monthly'}
              </button>
            )}

            {isMonthly && !billing?.subscriptionCancelAtPeriodEnd && (
              <div className="mt-3">
                {renewalDate && <p className="text-xs text-slate-400">Renews {renewalDate}</p>}
                {isOwner && (
                  <button
                    type="button"
                    onClick={handleCancelPlan}
                    disabled={planBusy}
                    className="mt-2 text-xs font-medium text-red-500 hover:text-red-600 disabled:opacity-40"
                  >
                    {planBusy ? 'Canceling…' : 'Cancel plan'}
                  </button>
                )}
              </div>
            )}

            {isMonthly && billing?.subscriptionCancelAtPeriodEnd && (
              <div className="mt-3">
                {renewalDate && <p className="text-xs text-amber-600">Ends {renewalDate}</p>}
                {isOwner && (
                  <button
                    type="button"
                    onClick={handleResumePlan}
                    disabled={planBusy}
                    className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:opacity-50"
                  >
                    {planBusy ? 'Resuming…' : 'Resume plan'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {planError && <p className="mt-3 text-xs text-red-600">{planError}</p>}
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Balance</p>
        <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">
          {balanceCents == null ? '—' : fmtUsd(balanceCents)}
        </p>

        {isOwner ? (
          <>
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

            <div className="mt-3 flex items-center gap-2">
              <div className="flex items-center rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus-within:border-blue-400">
                <span className="text-slate-400">$</span>
                <input
                  type="number"
                  min={MIN_TOPUP_CENTS / 100}
                  max={MAX_TOPUP_CENTS / 100}
                  step="1"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  placeholder="Custom amount"
                  className="ml-1 w-28 text-slate-800 outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleCustomTopUp}
                disabled={starting !== null || !customAmount}
                className="rounded-xl border-2 border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {customAmountError && <p className="mt-1 text-xs text-red-600">{customAmountError}</p>}

            <p className="mt-3 text-xs text-slate-400">
              Secure payment via Stripe.{testMode && ' Test mode.'}
            </p>
          </>
        ) : (
          <p className="mt-4 text-xs text-slate-400">
            Only the company owner can buy credits or change the plan.
          </p>
        )}
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-slate-700">Auto top-up</p>
        <p className="mt-1 text-xs text-slate-500">
          Automatically recharge your balance from a saved card so you never run out of credits mid-project.
        </p>

        {billing?.autoTopupDisabledReason && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Auto top-up was turned off: {billing.autoTopupDisabledReason}
          </div>
        )}

        {!isOwner ? (
          <p className="mt-4 text-xs text-slate-400">
            Only the company owner can manage the card and auto top-up.
          </p>
        ) : !billing?.hasSavedCard ? (
          <button
            type="button"
            onClick={handleAddCard}
            disabled={cardBusy}
            className="mt-4 rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-700 disabled:cursor-wait disabled:opacity-50"
          >
            {cardBusy ? 'Redirecting…' : 'Save a card'}
          </button>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="text-slate-700">
                {billing.cardBrand ? `${billing.cardBrand.toUpperCase()} •••• ${billing.cardLast4}` : 'Card on file'}
              </span>
              <button
                type="button"
                onClick={handleRemoveCard}
                disabled={cardBusy}
                className="text-xs font-medium text-red-500 hover:text-red-600 disabled:opacity-40"
              >
                Remove
              </button>
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                className="accent-blue-600"
              />
              Enable auto top-up
            </label>

            {autoEnabled && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600">When balance drops below</label>
                  <div className="mt-1 flex items-center rounded-lg border border-slate-200 px-3 py-2 text-sm focus-within:border-blue-400">
                    <span className="text-slate-400">$</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={thresholdInput}
                      onChange={(e) => setThresholdInput(e.target.value)}
                      placeholder="25"
                      className="ml-1 w-full text-slate-800 outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">Top up to</label>
                  <div className="mt-1 flex items-center rounded-lg border border-slate-200 px-3 py-2 text-sm focus-within:border-blue-400">
                    <span className="text-slate-400">$</span>
                    <input
                      type="number"
                      min={MIN_TOPUP_CENTS / 100}
                      max={MAX_TOPUP_CENTS / 100}
                      step="1"
                      value={targetInput}
                      onChange={(e) => setTargetInput(e.target.value)}
                      placeholder="100"
                      className="ml-1 w-full text-slate-800 outline-none"
                    />
                  </div>
                </div>
              </div>
            )}

            {autoTopupError && <p className="mt-2 text-xs text-red-600">{autoTopupError}</p>}

            <button
              type="button"
              onClick={handleSaveAutoTopup}
              disabled={savingAutoTopup}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {savingAutoTopup ? 'Saving…' : 'Save auto top-up settings'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
