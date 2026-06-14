import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { contractorQuestionnaire } from '@bid-wise/data';
import { generateTakeoff, performTakeoffs, type PricingMatrix, type Takeoff, type TakeoffPhase } from '../lib/supabase';
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

export function Questionnaire({ pricingMatrix = EMPTY_MATRIX, planId, trades: allowedTrades }: { pricingMatrix?: PricingMatrix; planId?: string; trades?: string[] }) {
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
  const streamRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamingText, compileTrades, phase]);

  // Elapsed-time clock: runs while a takeoff is generating; cleaned up on finish/unmount.
  useEffect(() => {
    if (passthroughPending) {
      startTimeRef.current = Date.now();
      setElapsedMs(0);
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
  const advancePhase = (next: TakeoffPhase) =>
    setPhase((cur) =>
      PHASE_ORDER.indexOf(next) >= PHASE_ORDER.indexOf(cur ?? next) ? next : cur,
    );

  const passthroughActions: Record<string, (selections: string[]) => Promise<unknown>> = {
    takeoffs: planId
      ? (trades) => generateTakeoff(planId, trades, setStreamingText, {
          onPhase: advancePhase,
          onProgress: (captured) => setCompileTrades(captured),
        }).then((t) => [t])
      : performTakeoffs,
  };

  const question = currentQuestionId ? questions[currentQuestionId] : null;

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
        setPassthroughPending(true);
        setPassthroughError(null);
        try {
          const result = await action(chosen.map((c) => c.value));
          if (Array.isArray(result) && result.length > 0) {
            if (planId) {
              navigate(`/projects/${planId}`);
              return;
            }
            setTakeoffs(result as Takeoff[]);
          }
        } catch (err) {
          setPassthroughError(
            err instanceof Error ? err.message : 'Takeoff generation failed.',
          );
          return;
        } finally {
          setPassthroughPending(false);
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
    startTimeRef.current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  if (question) {
    return (
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
                  <span className="h-2 w-2 animate-pulse rounded-full bg-green-400" />
                  <span className="text-xs text-green-400">live</span>
                </div>
              </div>
            </div>
            {/* Phase stepper */}
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
              {streamingText
                ? <span className="whitespace-pre-wrap">{streamingText}</span>
                : <span className="text-slate-500">Initializing…</span>
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

export function QuestionnaireForPlan({ pricingMatrix, trades }: { pricingMatrix?: PricingMatrix; trades?: string[] }) {
  const { planId } = useParams<{ planId: string }>();
  return <Questionnaire pricingMatrix={pricingMatrix} planId={planId} trades={trades} />;
}
