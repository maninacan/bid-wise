import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { contractorQuestionnaire } from '@bid-wise/data';
import { generateTakeoff, performTakeoffs, cancelTakeoff, cancelAllActiveTakeoffs, getActiveTakeoffJob, getActiveTakeoffJobs, getFinalizedTakeoffForPlan, planDisplayName, unfinalizeBid, subscribeTakeoffJob, subscribeUserTakeoffJobs, TakeoffCanceledError, type HousePlan, type PricingMatrix, type Takeoff, type TakeoffPhase, type TakeoffJob } from '../lib/supabase';
import { TakeoffView } from './takeoff-view';

const { questions, results, start } = contractorQuestionnaire;

const STORAGE_KEY = 'bid-wise:questionnaire-responses';

interface HistoryEntry {
  questionId: string;
  pendingBranches: string[];
  resultIds: string[];
  selected: string[];
  answers: Record<string, string[]>;
}

function saveResponses(answers: Record<string, string[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch {
    // localStorage unavailable (private mode, quota) — continue without persisting
  }
}

const permitBadgeStyles: Record<string, string> = {
  required: 'bg-red-100 text-red-800',
  common: 'bg-amber-100 text-amber-800',
  rare: 'bg-green-100 text-green-800',
};

const EMPTY_MATRIX: PricingMatrix = { unitDefaults: {}, tradeOverrides: [] };

const PHASE_ORDER: TakeoffPhase[] = ['reading', 'analyzing', 'compiling', 'saving'];
const PHASE_STEPS: { phase: TakeoffPhase; label: string }[] = [
  { phase: 'reading', label: 'Reading plans' },
  { phase: 'analyzing', label: 'Analyzing' },
  { phase: 'compiling', label: 'Compiling' },
  { phase: 'saving', label: 'Saving' },
];

const fmtElapsed = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function Questionnaire({ pricingMatrix = EMPTY_MATRIX, planId, planName, trades: allowedTrades }: { pricingMatrix?: PricingMatrix; planId?: string; planName?: string; trades?: string[] }) {
  const navigate = useNavigate();
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(start);
  const [pendingBranches, setPendingBranches] = useState<string[]>([]);
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [passthroughPending, setPassthroughPending] = useState(false);
  const [passthroughError, setPassthroughError] = useState<string | null>(null);
  const [takeoffs, setTakeoffs] = useState<Takeoff[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [phase, setPhase] = useState<TakeoffPhase | null>(null);
  const [compileTrades, setCompileTrades] = useState<string[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reattached, setReattached] = useState(false);
  const [reattachCount, setReattachCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  // Set when the user requests cancellation, so the in-flight generateTakeoff rejection
  // is treated as a clean stop rather than surfaced as a generation error.
  const cancelingRef = useRef(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // For a reattached (post-refresh) job the clock is anchored to the job's start time.
  const reattachStartRef = useRef<number | null>(null);
  const reattachCheckedRef = useRef(false);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamingText, compileTrades, phase]);

  // Elapsed-time clock: runs while a takeoff is generating; cleaned up on finish/unmount.
  useEffect(() => {
    if (passthroughPending) {
      startTimeRef.current = reattachStartRef.current ?? Date.now();
      setElapsedMs(Date.now() - startTimeRef.current);
      timerRef.current = setInterval(() => {
        if (startTimeRef.current != null) setElapsedMs(Date.now() - startTimeRef.current);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [passthroughPending]);

  // Monotonic: a late 'analyzing' (text after compiling) must not regress the stepper.
  const advancePhase = (next: TakeoffPhase | null) =>
    setPhase((cur) =>
      next != null && PHASE_ORDER.indexOf(next) >= PHASE_ORDER.indexOf(cur ?? next) ? next : cur,
    );

  // Reattach: if a generation is already running for this plan (e.g. after a page
  // refresh or in another tab), drive the progress view from the takeoff_jobs row.
  useEffect(() => {
    if (!planId || reattachCheckedRef.current) return;
    reattachCheckedRef.current = true;
    let unsubscribe: (() => void) | undefined;
    getActiveTakeoffJob(planId)
      .then((job) => {
        if (!job) return;
        reattachStartRef.current = new Date(job.created_at).getTime();
        setReattached(true);
        setPhase(job.phase);
        setCompileTrades(job.trades ?? []);
        setStreamingText(job.narration ?? '');
        setPassthroughPending(true);
        unsubscribe = subscribeTakeoffJob(planId, (next: TakeoffJob) => {
          if (next.status === 'running') {
            advancePhase(next.phase);
            setCompileTrades(next.trades ?? []);
            setStreamingText(next.narration ?? '');
          } else if (next.status === 'done') {
            navigate(
              next.takeoff_id
                ? `/projects/${planId}/takeoffs/${next.takeoff_id}`
                : `/projects/${planId}`,
            );
          } else if (next.status === 'error') {
            setPassthroughError(next.error ?? 'Takeoff generation failed.');
            setPassthroughPending(false);
            setReattached(false);
          } else if (next.status === 'canceled') {
            setPassthroughPending(false);
            setReattached(false);
            setStopping(false);
            cancelingRef.current = false;
          }
        });
      })
      .catch(() => { /* no active job / not reattaching */ });
    return () => unsubscribe?.();
  }, [planId, navigate]);

  // Reattach for the multi-plan flow (no specific plan): if any generation is running
  // for the user, show aggregate progress and send them to /projects when all finish.
  useEffect(() => {
    if (planId || reattachCheckedRef.current) return;
    reattachCheckedRef.current = true;
    let unsubscribe: (() => void) | undefined;
    getActiveTakeoffJobs()
      .then((jobs) => {
        if (jobs.length === 0) return;
        const running = new Set(jobs.map((j) => j.id));
        reattachStartRef.current = Math.min(...jobs.map((j) => new Date(j.created_at).getTime()));
        setReattached(true);
        setReattachCount(running.size);
        setCompileTrades([...new Set(jobs.flatMap((j) => j.trades ?? []))]);
        setPassthroughPending(true);
        unsubscribe = subscribeUserTakeoffJobs((next: TakeoffJob) => {
          if (next.status === 'running') running.add(next.id);
          else running.delete(next.id);
          setReattachCount(running.size);
          if (running.size === 0) navigate('/projects');
        });
      })
      .catch(() => { /* no active jobs / not reattaching */ });
    return () => unsubscribe?.();
  }, [planId, navigate]);

  const passthroughActions: Record<string, (selections: string[]) => Promise<unknown>> = {
    takeoffs: planId
      ? (trades) => generateTakeoff(planId, trades, setStreamingText, {
          onPhase: advancePhase,
          onProgress: (captured) => setCompileTrades(captured),
        }).then((t) => [t])
      : performTakeoffs,
  };

  const question = currentQuestionId ? questions[currentQuestionId] : null;
  // Multi-plan (no specific plan) reattach: aggregate progress, no per-phase stepper.
  const genericReattach = reattached && !planId;

  const toggleChoice = (value: string) => {
    setPassthroughError(null);
    if (!question) return;
    setSelected((prev) => {
      if (question.select === 'one') {
        return new Set(prev.has(value) ? [] : [value]);
      }
      const choice = question.choices.find((c) => c.value === value);
      if (choice?.specialAction?.type === 'select-all') {
        if (prev.has(value)) return new Set();
        const excluded = new Set(choice.specialAction.except ?? []);
        return new Set(
          question.choices
            .filter((c) => !excluded.has(c.value))
            .map((c) => c.value),
        );
      }
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  const handleNext = async () => {
    if (!question || !currentQuestionId) return;
    const chosen = question.choices.filter((choice) =>
      selected.has(choice.value),
    );

    const updatedAnswers = {
      ...answers,
      [question.id]: chosen.map((choice) => choice.value),
    };
    setAnswers(updatedAnswers);
    saveResponses(updatedAnswers);

    setHistory((prev) => [
      ...prev,
      {
        questionId: currentQuestionId,
        pendingBranches,
        resultIds,
        selected: [...selected],
        answers,
      },
    ]);

    if (question.passthrough) {
      const action = passthroughActions[question.passthrough];
      if (action) {
        setStreamingText('');
        setPhase(null);
        setCompileTrades([]);
        setReattached(false);
        setReattachCount(0);
        reattachStartRef.current = null; // live run: clock anchors to now
        cancelingRef.current = false; // fresh run: clear any prior cancellation guard
        setStopping(false);
        setPassthroughPending(true);
        setPassthroughError(null);
        try {
          const result = await action(chosen.map((c) => c.value));
          if (Array.isArray(result) && result.length > 0) {
            if (planId) {
              navigate(`/projects/${planId}/takeoffs/${(result[0] as Takeoff).id}`);
              return;
            }
            setTakeoffs(result as Takeoff[]);
          }
        } catch (err) {
          // A user-initiated cancellation isn't an error — leave the message clear.
          if (!(err instanceof TakeoffCanceledError) && !cancelingRef.current) {
            setPassthroughError(
              err instanceof Error ? err.message : 'Takeoff generation failed.',
            );
          }
          return;
        } finally {
          setPassthroughPending(false);
          setStopping(false);
          cancelingRef.current = false;
        }
      }
    }

    const queue = [...chosen.map((choice) => choice.next), ...pendingBranches];
    // Collect result ids until we reach the next question; the rest wait.
    const reachedResults: string[] = [];
    let nextQuestionId: string | null = null;
    let remaining: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      if (questions[queue[i]]) {
        nextQuestionId = queue[i];
        remaining = queue.slice(i + 1);
        break;
      }
      reachedResults.push(queue[i]);
    }
    setResultIds((prev) => [...prev, ...reachedResults]);
    setPendingBranches(remaining);
    setSelected(new Set());
    setCurrentQuestionId(nextQuestionId);
  };

  // Stop an in-progress generation. Asks the server to cancel, then returns to the
  // questionnaire immediately rather than waiting on the in-flight stream to unwind —
  // that can lag by a few seconds. cancelingRef stays set so the eventual stream
  // rejection (TakeoffCanceledError) is swallowed instead of shown as an error; it's
  // cleared when the next generation starts (and by handleNext's finally for live runs).
  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    cancelingRef.current = true;
    try {
      if (planId) await cancelTakeoff(planId);
      else await cancelAllActiveTakeoffs();
    } catch {
      // Best-effort: the run may have already finished. Tear the view down regardless.
    } finally {
      setPassthroughPending(false);
      setStopping(false);
      setReattached(false);
      setReattachCount(0);
      setStreamingText('');
      setPhase(null);
      setCompileTrades([]);
    }
  };

  const handleBack = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    setCurrentQuestionId(previous.questionId);
    setPendingBranches(previous.pendingBranches);
    setResultIds(previous.resultIds);
    setSelected(new Set(previous.selected));
    setAnswers(previous.answers);
  };

  const startOver = () => {
    setCurrentQuestionId(start);
    setPendingBranches([]);
    setResultIds([]);
    setSelected(new Set());
    setAnswers({});
    setHistory([]);
    setTakeoffs([]);
    setStreamingText('');
    setPhase(null);
    setCompileTrades([]);
    setElapsedMs(0);
    setReattached(false);
    setReattachCount(0);
    startTimeRef.current = null;
    reattachStartRef.current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  if (question) {
    return (
      <>
        {planId && (
          <button
            type="button"
            onClick={() => navigate(`/projects/${planId}`)}
            className="mb-5 flex items-center gap-1.5 self-start text-sm font-medium text-slate-500 transition-colors hover:text-slate-800"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to project
          </button>
        )}
        {planName && (
          <h1 className="self-start text-left text-xl font-semibold text-slate-800">{planName}</h1>
        )}
        {/* Hide the question + trade buttons once generation starts so the output is top and center. */}
        {!passthroughPending && (
        <>
        <h1 className="mt-10 text-center text-xl font-semibold text-slate-800">
          {question.text}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {question.select === 'multiple'
            ? 'Select all that apply.'
            : 'Select one.'}
        </p>

        <div className="mt-8 grid w-full grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {(allowedTrades && allowedTrades.length > 0
            ? question.choices.filter((c) => allowedTrades.includes(c.value))
            : question.choices
          ).map((choice) => {
            const isSelected = selected.has(choice.value);
            return (
              <button
                key={choice.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggleChoice(choice.value)}
                className={`relative rounded-xl border-2 px-4 py-6 text-center text-sm font-medium shadow-sm transition-colors ${
                  isSelected
                    ? 'border-blue-600 bg-blue-50 text-blue-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50/50'
                }`}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs text-white"
                  >
                    ✓
                  </span>
                )}
                {choice.label}
              </button>
            );
          })}
        </div>
        </>
        )}

        {passthroughError && (
          <p className="mt-6 text-sm text-red-600">{passthroughError}</p>
        )}

        {passthroughPending && (
          <div className="mt-8 w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-lg">
            {/* Terminal chrome */}
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <span className="h-3 w-3 rounded-full bg-slate-700" />
                  <span className="h-3 w-3 rounded-full bg-slate-700" />
                  <span className="h-3 w-3 rounded-full bg-slate-700" />
                </div>
                <span className="font-mono text-xs text-slate-400">generate-takeoff</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs tabular-nums text-slate-400">{fmtElapsed(elapsedMs)}</span>
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${stopping ? 'bg-amber-400' : 'animate-pulse bg-green-400'}`} />
                  <span className={`text-xs ${stopping ? 'text-amber-400' : 'text-green-400'}`}>{stopping ? 'stopping' : 'live'}</span>
                </div>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={stopping}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 font-mono text-xs text-slate-300 transition-colors hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="h-2 w-2 rounded-sm bg-red-400" />
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            </div>
            {/* Phase stepper (per-plan only; the multi-plan reattach has no single phase) */}
            {!genericReattach && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-slate-800 px-4 py-2.5">
              {PHASE_STEPS.map((step) => {
                const stepIdx = PHASE_ORDER.indexOf(step.phase);
                const curIdx = phase ? PHASE_ORDER.indexOf(phase) : -1;
                const done = curIdx > stepIdx;
                const active = curIdx === stepIdx;
                return (
                  <span key={step.phase} className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        done ? 'bg-green-400' : active ? 'animate-pulse bg-green-400' : 'bg-slate-700'
                      }`}
                    />
                    <span
                      className={`font-mono text-[11px] ${
                        done ? 'text-green-400' : active ? 'text-green-300' : 'text-slate-500'
                      }`}
                    >
                      {step.label}
                    </span>
                  </span>
                );
              })}
            </div>
            )}
            {/* Advisory */}
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-xs text-amber-300/90">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" d="M12 7v5l3 2" />
              </svg>
              <span>Analyzing the full plan set can take a few minutes — you can leave this open.</span>
            </div>
            {/* Streaming output */}
            <div
              ref={streamRef}
              className="h-72 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-green-300"
            >
              {genericReattach
                ? <span className="text-slate-500">Resuming… generating {reattachCount} takeoff{reattachCount === 1 ? '' : 's'}. You’ll be taken to your projects when complete.</span>
                : streamingText
                  ? <span className="whitespace-pre-wrap">{streamingText}</span>
                  : <span className="text-slate-500">{reattached ? 'Resuming…' : 'Initializing…'}</span>
              }
              {phase === 'compiling' && (
                <p className="mt-3 text-green-300">
                  Compiling takeoff ▸ {compileTrades.join(', ')}
                  {compileTrades.length > 0 && `… (${compileTrades.length} trades captured)`}
                  <span className="animate-pulse">▋</span>
                </p>
              )}
              {phase === 'saving' && (
                <p className="mt-3 text-green-300">Saving takeoff…<span className="animate-pulse">▋</span></p>
              )}
              {streamingText && phase !== 'compiling' && phase !== 'saving' && (
                <span className="animate-pulse text-green-300">▋</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-10 flex items-center gap-4">
          {history.length > 0 && !passthroughPending && (
            <button
              type="button"
              onClick={handleBack}
              className="rounded-lg border-2 border-slate-300 bg-white px-10 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={handleNext}
            disabled={selected.size === 0 || passthroughPending}
            className="rounded-lg bg-blue-600 px-10 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {passthroughPending ? 'Generating…' : question.passthrough ? 'Generate Takeoffs' : 'Next'}
          </button>
        </div>
      </>
    );
  }

  return (
    <section className="mt-10 w-full">
      <h1 className="text-center text-xl font-semibold text-slate-800">
        Your bid profile{resultIds.length > 1 ? 's' : ''}
      </h1>

      {[...new Set(resultIds)].map((id) => {
        const result = results[id];
        return (
          <article
            key={id}
            className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">
                {result.bidProfile}
              </h2>
              <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                {result.pricingModel}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${permitBadgeStyles[result.permitLikelihood]}`}
              >
                permit {result.permitLikelihood}
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-600">{result.description}</p>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-blue-700">
                Typical line items ({result.typicalLineItems.length})
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                {result.typicalLineItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          </article>
        );
      })}

      {takeoffs.length > 0 && (
        <div className="mt-10 w-full">
          <h2 className="text-center text-xl font-semibold text-slate-800">
            Quantity Takeoffs
          </h2>
          <p className="mt-1 text-center text-sm text-slate-500">
            Generated from your uploaded plans
          </p>
          {takeoffs.map((takeoff) => (
            <TakeoffView
              key={takeoff.id}
              takeoff={takeoff}
              planName={takeoff.data.projectName}
              pricingMatrix={pricingMatrix}
            />
          ))}
        </div>
      )}

      <div className="mt-10 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={handleBack}
          className="rounded-lg border-2 border-slate-300 bg-white px-8 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
        >
          Back
        </button>
        <button
          type="button"
          onClick={startOver}
          className="rounded-lg border-2 border-slate-300 bg-white px-8 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
        >
          Start over
        </button>
      </div>
    </section>
  );
}

/** Blocks the questionnaire when the project's bid is finalized or sent, and offers an
 *  un-finalize path (finalized only — a sent bid is permanently locked). */
function FinalizedNotice({
  planId,
  planName,
  sent,
  takeoffId,
  onReopened,
}: {
  planId: string;
  planName?: string;
  sent: boolean;
  takeoffId?: string;
  onReopened: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnfinalize = async () => {
    if (!takeoffId) return;
    setBusy(true);
    setError(null);
    try {
      await unfinalizeBid(takeoffId);
      onReopened();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not un-finalize the bid.');
      setBusy(false);
    }
  };

  return (
    <section className="mt-10 w-full max-w-xl">
      <button
        type="button"
        onClick={() => navigate(`/projects/${planId}`)}
        className="mb-5 flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to project
      </button>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${sent ? 'bg-green-100 text-green-600' : 'bg-amber-100 text-amber-600'}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="mt-4 text-lg font-semibold text-slate-900">
          {planName ? `${planName} is ${sent ? 'sent' : 'finalized'}` : `This project is ${sent ? 'sent' : 'finalized'}`}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
          {sent
            ? 'This bid has been sent to the customer, so the project is locked. No new takeoffs can be created.'
            : 'This project’s bid is finalized and locked. To create new takeoffs or change the bid, un-finalize it first.'}
        </p>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/projects/${planId}`)}
            className="rounded-lg border-2 border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-400 hover:text-blue-700"
          >
            Back to project
          </button>
          {!sent && (
            <button
              type="button"
              onClick={handleUnfinalize}
              disabled={busy || !takeoffId}
              className="rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-500 disabled:cursor-wait disabled:bg-slate-300"
            >
              {busy ? 'Un-finalizing…' : 'Un-finalize bid'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

type LockState =
  | { status: 'loading' | 'open' }
  | { status: 'finalized' | 'sent'; takeoffId: string };

export function QuestionnaireForPlan({ plans = [], pricingMatrix, trades }: { plans?: HousePlan[]; pricingMatrix?: PricingMatrix; trades?: string[] }) {
  const { planId } = useParams<{ planId: string }>();
  const plan = plans.find((p) => p.id === planId);
  const planName = plan ? planDisplayName(plan) : undefined;

  // A finalized (or sent) bid locks the project from new takeoffs — gate on it before
  // rendering the questionnaire.
  const [lock, setLock] = useState<LockState>({ status: 'loading' });

  useEffect(() => {
    if (!planId) {
      setLock({ status: 'open' });
      return;
    }
    let active = true;
    setLock({ status: 'loading' });
    getFinalizedTakeoffForPlan(planId)
      .then((t) => {
        if (!active) return;
        if (!t) setLock({ status: 'open' });
        else setLock({ status: t.data.bid?.sentAt ? 'sent' : 'finalized', takeoffId: t.id });
      })
      .catch(() => active && setLock({ status: 'open' }));
    return () => {
      active = false;
    };
  }, [planId]);

  if (lock.status === 'loading') {
    return <p className="mt-10 text-center text-sm text-slate-500">Loading…</p>;
  }
  if (lock.status === 'finalized' || lock.status === 'sent') {
    return (
      <FinalizedNotice
        planId={planId!}
        planName={planName}
        sent={lock.status === 'sent'}
        takeoffId={lock.takeoffId}
        onReopened={() => setLock({ status: 'open' })}
      />
    );
  }
  return <Questionnaire pricingMatrix={pricingMatrix} planId={planId} planName={planName} trades={trades} />;
}
