// Express handler: analyze a house plan PDF and generate a quantity takeoff.
// Streams NDJSON, one JSON object per line:
//   { type: 'phase', phase }      progress milestone (reading|analyzing|compiling|saving)
//   { type: 'token', text }       a chunk of the model's narration
//   { type: 'progress', trades }  trades captured so far while compiling the structured output
//   { type: 'done', takeoff }     final saved takeoff
//   { type: 'error', error }      failure at any stage
// Blank lines are heartbeats (the client ignores them) to keep the connection visibly alive.
// Ported from the former Supabase edge function so all backend logic lives in the api app.
import type { Request, Response } from 'express';
import { supabaseAdmin, getUserFromAuthHeader } from './lib/supabase-admin';
import { getAnthropic, CLAUDE_MODEL } from './lib/anthropic';
import { trackUsage } from './track-usage';

type Phase = 'reading' | 'analyzing' | 'compiling' | 'saving';

// A 'running' job older than this is treated as abandoned (e.g. server restart),
// so it neither blocks a new run nor reattaches in the client.
const STALE_MS = 10 * 60 * 1000;

// Canonical bid units. Pricing does an exact `unitDefaults[unit]` lookup, so units must be
// consistent — map common model variants to a single uppercase abbreviation.
const UNIT_ALIASES: Record<string, string> = {
  sf: 'SF', sqft: 'SF', 'sq ft': 'SF', 'square feet': 'SF', 'square foot': 'SF', ft2: 'SF', sft: 'SF',
  sq: 'SQ', square: 'SQ', squares: 'SQ', sqs: 'SQ',
  lf: 'LF', lnft: 'LF', 'ln ft': 'LF', 'lin ft': 'LF', 'lineal feet': 'LF', 'linear feet': 'LF', 'linear foot': 'LF',
  sy: 'SY', 'sq yd': 'SY', 'square yards': 'SY', 'square yard': 'SY',
  cy: 'CY', 'cu yd': 'CY', 'cubic yards': 'CY', 'cubic yard': 'CY', yd3: 'CY',
  cf: 'CF', 'cu ft': 'CF', 'cubic feet': 'CF', 'cubic foot': 'CF', ft3: 'CF',
  ea: 'EA', each: 'EA', ct: 'EA', count: 'EA', pc: 'EA', pcs: 'EA', piece: 'EA', pieces: 'EA', unit: 'EA', units: 'EA', no: 'EA', nos: 'EA',
  ls: 'LS', 'lump sum': 'LS', lumpsum: 'LS', allowance: 'LS', allow: 'LS',
  ton: 'TON', tons: 'TON', tn: 'TON',
  gal: 'GAL', gallon: 'GAL', gallons: 'GAL',
  bf: 'BF', 'board feet': 'BF', 'board foot': 'BF', 'bd ft': 'BF', fbm: 'BF',
  pr: 'PR', pair: 'PR', pairs: 'PR',
  hr: 'HR', hrs: 'HR', hour: 'HR', hours: 'HR',
};
function normalizeUnit(raw: string): string {
  const cleaned = String(raw ?? '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return UNIT_ALIASES[cleaned] ?? String(raw ?? '').trim().toUpperCase();
}

// Static takeoff instructions — byte-identical on every run, so they live in a cached
// `system` block (the per-request trade scope is sent separately in the user message).
const TAKEOFF_INSTRUCTIONS = `You are an experienced construction quantity surveyor and estimator.

Analyze the architectural plans provided and generate a complete quantity takeoff.

As you work through each trade, briefly narrate what you're doing: which sheets you're referencing, how you're deriving quantities, and key assumptions. Keep this commentary tight — a few lines per trade, not paragraphs. Reserve most of your output for the structured tool call.

Each line item must be a concrete, real construction material or installed work item that a subcontractor would price (e.g. "1/2\\" gypsum board", "R-21 batt insulation", "30-year architectural shingles") — never vague placeholders, headings, or duplicates.

CRITICAL — the line items feed a materials list and a priced bid, so duplicates corrupt the totals:
- Within a trade, list each distinct material exactly ONCE. If the same material appears in several places, consolidate it into a single line with the summed quantity.
- Do not emit near-duplicate descriptions that refer to the same material (e.g. "2x4 stud" and "2x4 studs", or the same item with different wording). Pick one description per material.
- Each description within a trade must be unique.

CRITICAL — trade grouping for exterior cladding: if the plans show ANY siding, stone/rock veneer, brick veneer, stucco, soffit, fascia, rain gutters, downspouts, exterior trim/casing around windows and doors, or house wrap / weather-resistive barrier, you MUST create a dedicated trade section named exactly "Siding & Exterior Trim" containing those items. Do NOT fold them into "Framing", "Finish Work", "Roofing", or any other trade, even though that grouping might otherwise feel natural — this is a hard requirement, not a suggestion. "Siding & Exterior Trim" must appear as one of your returned sections whenever any of these materials are present.
"Concrete / Masonry" is structural only — footings, foundation walls, slabs, CMU block, structural brick/block walls. Never put brick or stone/rock veneer or other cladding there; that always belongs under "Siding & Exterior Trim".

Use the unit of measure each item is conventionally bid in across the industry, as an uppercase abbreviation from this set ONLY:
- SF — area work: drywall, flooring, paint/coatings, tile, insulation, siding, sheathing
- SQ — roofing (1 SQ = 100 SF of roof)
- LF — linear runs: trim/baseboard/casing, pipe, conduit, gutter, footings, framing runs
- SY — carpet, paving
- CY — concrete, excavation, gravel, fill
- CF — loose volume (e.g. some gravel/mulch)
- EA — discrete units: fixtures, doors, windows, appliances, cabinets, equipment
- LS — lump sum: general conditions, mobilization, allowances
- TON — HVAC equipment tonnage, structural steel, asphalt
- GAL — bulk liquids
- BF — rough lumber (board feet)
- PR — pairs
- HR — hourly labor
Pick the single most standard unit per item; do not invent other unit strings.

For each line item, classify the source:
- "stated" — the quantity is explicitly called out on the plans (e.g., a schedule or note gives the count)
- "derived" — the quantity was calculated from plan dimensions (e.g., area from room footprint)
- "estimated" — the quantity was estimated based on typical construction practice (e.g., rough-in counts per fixture)

Identify gaps where information is missing or ambiguous — things a contractor would need to clarify before confidently pricing the job.

Also populate "acronyms": list every abbreviation or acronym you used anywhere in this takeoff — every unit of measure, plus any acronyms in line-item descriptions — each paired with its full plain-English meaning (e.g. "MO" → "Month", "GFCI" → "Ground-fault circuit interrupter"). Do not include plain words that aren't abbreviations.

Before calling submit_takeoff, double-check: if any siding, veneer, stucco, soffit, fascia, gutters, downspouts, exterior trim, or house wrap appear in your sections, confirm they're grouped under their own "Siding & Exterior Trim" section rather than scattered into Framing, Finish Work, or Roofing.

Once your analysis is complete, call submit_takeoff with all the structured results.`;

export async function generateTakeoffHandler(req: Request, res: Response): Promise<void> {
  // NDJSON streaming: one JSON object per line. Disable buffering so chunks reach the
  // client immediately (X-Accel-Buffering defeats nginx proxy buffering if present).
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

  // The takeoff_jobs row mirrors progress so other tabs / a refreshed page can reattach,
  // and acts as the per-plan lock. The server keeps running after a client disconnect,
  // so the row is finalized regardless of whether anyone is still listening.
  let jobId: string | null = null;
  let finalized = false;
  const updateJob = async (patch: Record<string, unknown>) => {
    if (!jobId) return;
    try {
      await supabaseAdmin
        .from('takeoff_jobs')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    } catch (err) {
      console.error('[generate-takeoff] job update failed:', err);
    }
  };

  let currentPhase: Phase | null = null;
  const setPhase = (phase: Phase) => {
    if (phase !== currentPhase) {
      currentPhase = phase;
      write({ type: 'phase', phase });
      void updateJob({ phase });
    }
  };

  // Heartbeat: a blank line every 10s keeps the stream alive during quiet stretches
  // (notably the 'saving' DB write), and bumps updated_at so a long run isn't seen as stale.
  const heartbeat = setInterval(() => {
    try { res.write('\n'); } catch { /* socket closed */ }
    void updateJob({});
  }, 10000);

  // Cancellation: the client can't write the job row (RLS is read-only), so it asks the
  // api to flip cancel_requested. Poll for that flag and abort the model stream when set.
  // The server keeps running after a client disconnect, so this is the only way to stop it.
  let canceled = false;
  let abortStream: (() => void) | null = null;
  const cancelPoll = setInterval(() => {
    if (!jobId || canceled) return;
    void (async () => {
      try {
        const { data } = await supabaseAdmin
          .from('takeoff_jobs')
          .select('cancel_requested')
          .eq('id', jobId)
          .single();
        if (data?.cancel_requested) {
          canceled = true;
          abortStream?.();
        }
      } catch { /* transient read error — retry next tick */ }
    })();
  }, 3000);

  try {
    setPhase('reading');
    const supabase = supabaseAdmin;

    const user = await getUserFromAuthHeader(req.headers.authorization ?? '');
    if (!user) {
      write({ type: 'error', error: 'Not authenticated.' });
      return;
    }

    const { plan_id, trades } = (req.body ?? {}) as { plan_id?: string; trades?: string[] };
    if (!plan_id) {
      write({ type: 'error', error: 'plan_id is required.' });
      return;
    }

    const { data: plan, error: planError } = await supabase
      .from('house_plans')
      .select('id, file_name, storage_path')
      .eq('id', plan_id)
      .eq('user_id', user.id)
      .single();
    if (planError || !plan) {
      write({ type: 'error', error: 'Plan not found.' });
      return;
    }

    // Once a bid for this project has been sent to the customer, the project is locked.
    const { data: sentBid } = await supabase
      .from('takeoffs')
      .select('id')
      .eq('plan_id', plan_id)
      .eq('archived', false)
      .not('data->bid->>sentAt', 'is', null)
      .limit(1)
      .maybeSingle();
    if (sentBid) {
      write({ type: 'error', error: 'This project’s bid has been sent — no new takeoffs can be created.' });
      return;
    }

    // Per-plan lock: refuse if a non-stale job is already running for this plan.
    // A stale running row (crashed server) is finalized to free the unique slot.
    const { data: existing } = await supabase
      .from('takeoff_jobs')
      .select('id, updated_at')
      .eq('user_id', user.id)
      .eq('plan_id', plan_id)
      .eq('status', 'running')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      const stale = Date.now() - new Date(existing.updated_at as string).getTime() > STALE_MS;
      if (!stale) {
        write({ type: 'error', error: 'A takeoff is already generating for this plan.' });
        return;
      }
      await supabase
        .from('takeoff_jobs')
        .update({ status: 'error', error: 'Generation was interrupted (server restart).', updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }

    const { data: job, error: jobError } = await supabase
      .from('takeoff_jobs')
      .insert({ user_id: user.id, plan_id, status: 'running', phase: 'reading', trades: trades ?? [] })
      .select('id')
      .single();
    if (jobError || !job) {
      // 23505 = unique violation: lost the race to another request for the same plan.
      const code = (jobError as { code?: string } | null)?.code;
      const msg = code === '23505'
        ? 'A takeoff is already generating for this plan.'
        : 'Failed to start takeoff generation.';
      write({ type: 'error', error: msg });
      return;
    }
    jobId = job.id;

    const { data: signedData, error: signedError } = await supabase.storage
      .from('house-plans')
      .createSignedUrl(plan.storage_path, 300);
    if (signedError || !signedData) {
      write({ type: 'error', error: 'Failed to access plan file.' });
      return;
    }

    const pdfRes = await fetch(signedData.signedUrl);
    if (!pdfRes.ok) {
      write({ type: 'error', error: 'Failed to download plan file.' });
      return;
    }

    const pdfBase64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');

    const anthropic = getAnthropic();
    const model = CLAUDE_MODEL;

    const tradesClause = trades?.length
      ? `Focus only on these trades: ${trades.join(', ')}.`
      : 'Cover all visible trades in the plans.';

    const claudeStream = anthropic.messages.stream({
      model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tool_choice: { type: 'auto' },
      tools: [
        {
          name: 'submit_takeoff',
          description: 'Submit the completed quantity takeoff for this project.',
          // Static tool schema — cache it as part of the stable request prefix.
          cache_control: { type: 'ephemeral' },
          input_schema: {
            type: 'object' as const,
            properties: {
              projectName: { type: 'string' },
              summary: {
                type: 'string',
                description: 'Brief project summary (2-4 sentences covering scope, style, and key features)',
              },
              areas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    squareFeet: { type: 'number' },
                  },
                  required: ['name', 'squareFeet'],
                  additionalProperties: false,
                },
              },
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    trade: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          description: { type: 'string' },
                          quantity: { type: 'number' },
                          unit: {
                            type: 'string',
                            description: 'Standard bid unit, uppercase abbreviation: SF, SQ, LF, SY, CY, CF, EA, LS, TON, GAL, BF, PR, or HR.',
                          },
                          source: {
                            type: 'string',
                            enum: ['stated', 'derived', 'estimated'],
                          },
                          notes: { type: 'string' },
                        },
                        required: ['description', 'quantity', 'unit', 'source'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['trade', 'items'],
                  additionalProperties: false,
                },
              },
              gaps: {
                type: 'array',
                description: 'Missing or unclear information a contractor would need to clarify before pricing.',
                items: {
                  type: 'object',
                  properties: {
                    trade: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['trade', 'description'],
                  additionalProperties: false,
                },
              },
              acronyms: {
                type: 'array',
                description:
                  'Every abbreviation or acronym used anywhere in this takeoff — each unit of measure (SF, LF, MO, …) plus any acronyms appearing in line-item descriptions (GFCI, PVC, OSB, …) — paired with its full plain-English meaning.',
                items: {
                  type: 'object',
                  properties: {
                    abbreviation: { type: 'string' },
                    meaning: { type: 'string' },
                  },
                  required: ['abbreviation', 'meaning'],
                  additionalProperties: false,
                },
              },
            },
            required: ['projectName', 'summary', 'areas', 'sections', 'gaps', 'acronyms'],
            additionalProperties: false,
          },
        },
      ],
      // Static instructions in a cached system block; the per-request trade scope and the
      // (per-plan) PDF go in the user message. Cache breakpoints on the tool, the system
      // block, and the document let repeat/same-plan generations reuse the prefix.
      system: [
        { type: 'text', text: TAKEOFF_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: tradesClause,
            },
          ],
        },
      ],
    });

    // Let the cancel poll abort this stream. If cancellation arrived while the PDF was
    // downloading (before the stream existed), abort right away.
    abortStream = () => claudeStream.abort();
    if (canceled) claudeStream.abort();

    // Forward narration tokens and, once the model switches to the submit_takeoff
    // tool JSON, surface trades as they're captured. inputJson's snapshot is the
    // progressively-parsed tool input (the raw partial_json isn't parseable mid-stream).
    let lastProgressKey = '';
    let narration = '';
    let lastNarrationFlush = 0;
    claudeStream
      .on('text', (delta) => {
        setPhase('analyzing');
        if (delta) {
          write({ type: 'token', text: delta });
          // Persist narration (throttled) so a reattaching client can restore it.
          narration += delta;
          const now = Date.now();
          if (now - lastNarrationFlush > 2000) {
            lastNarrationFlush = now;
            void updateJob({ narration });
          }
        }
      })
      .on('inputJson', (_partial, snapshot) => {
        setPhase('compiling');
        const sections = (snapshot as { sections?: { trade?: unknown }[] })?.sections;
        if (!Array.isArray(sections)) return;
        const trades = sections
          .map((s) => (typeof s?.trade === 'string' ? s.trade.trim() : ''))
          .filter(Boolean);
        const key = trades.join('');
        if (key !== lastProgressKey) {
          lastProgressKey = key;
          write({ type: 'progress', trades, count: trades.length });
          void updateJob({ trades });
        }
      })
      .on('error', (err) => console.error('[generate-takeoff] stream error:', err));

    const finalMessage = await claudeStream.finalMessage();
    // Final flush so the complete narration is persisted (the throttle may have skipped the tail).
    void updateJob({ narration });

    const toolUse = finalMessage.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      const reason = finalMessage.stop_reason === 'max_tokens'
        ? 'The plan was too large to complete in one pass. Please try fewer trades at a time.'
        : 'Model did not produce takeoff data.';
      write({ type: 'error', error: reason });
      return;
    }

    interface TakeoffLineItem {
      description: string;
      quantity: number;
      unit: string;
      source: string;
      notes?: string;
    }
    const takeoffData = toolUse.input as {
      projectName: string;
      summary: string;
      areas: { name: string; squareFeet: number }[];
      sections: { trade: string; items: TakeoffLineItem[] }[];
      gaps: { trade: string; description: string }[];
      acronyms?: { abbreviation: string; meaning: string }[];
    };

    // Safeguard: the bid keys prices by `${trade}::${description}` and sums each item's
    // quantity, so duplicate descriptions within a trade would double-count. Merge items
    // with the same (normalized) description, summing quantities, so each is unique.
    for (const section of takeoffData.sections ?? []) {
      const byDescription = new Map<string, TakeoffLineItem>();
      for (const item of section.items ?? []) {
        const key = String(item.description ?? '').trim().toLowerCase();
        const existing = byDescription.get(key);
        if (existing) {
          existing.quantity += Number(item.quantity) || 0;
        } else {
          byDescription.set(key, {
            ...item,
            description: String(item.description ?? '').trim(),
            unit: normalizeUnit(item.unit),
          });
        }
      }
      section.items = [...byDescription.values()];
    }

    // Dedupe acronyms by uppercased abbreviation, dropping blanks.
    if (Array.isArray(takeoffData.acronyms)) {
      const seen = new Set<string>();
      takeoffData.acronyms = takeoffData.acronyms.filter((a) => {
        const key = String(a?.abbreviation ?? '').trim().toUpperCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Persist the name as "yyyy-MM-dd HH:mm - <original name>".
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    takeoffData.projectName = `${ts} - ${takeoffData.projectName}`;

    setPhase('saving');
    const { data: savedTakeoff, error: insertError } = await supabase
      .from('takeoffs')
      .insert({ user_id: user.id, plan_id, model, data: takeoffData })
      .select('id, plan_id, model, data, created_at')
      .single();

    if (insertError || !savedTakeoff) {
      console.error('[generate-takeoff] insert error:', insertError?.message);
      write({ type: 'error', error: 'Failed to save takeoff.' });
      return;
    }

    await trackUsage(supabase, {
      user_id: user.id,
      plan_id,
      takeoff_id: savedTakeoff.id,
      operation: 'generate-takeoff',
      model,
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      cache_creation_input_tokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: finalMessage.usage.cache_read_input_tokens ?? 0,
    });

    await updateJob({ status: 'done', takeoff_id: savedTakeoff.id });
    finalized = true;

    write({ type: 'done', takeoff: savedTakeoff });
  } catch (err) {
    // A user cancellation aborts the model stream, which surfaces here as a thrown
    // error. Treat it as a clean stop, not a failure.
    if (canceled) {
      write({ type: 'canceled' });
      await updateJob({ status: 'canceled' });
      finalized = true;
    } else {
      console.error('[generate-takeoff] uncaught error:', err);
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      write({ type: 'error', error: message });
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    // Guarantee the job never stays 'running' if the handler exits for any reason.
    if (jobId && !finalized) {
      await updateJob({ status: 'error', error: 'Generation failed.' });
    }
    res.end();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait for the owning process to react to cancel_requested before assuming
// it's gone (e.g. killed by a server restart mid-run) and force-finalizing the job here.
// The owning process polls cancel_requested every 3s, so this gives ~2-3x margin.
const CANCEL_GRACE_MS = 8000;
const CANCEL_POLL_MS = 1000;

/** Requests cancellation of the running takeoff for a plan. Flips cancel_requested on the
 *  job row; the streaming handler polls it, aborts the model, and finalizes as 'canceled'.
 *
 *  That only works if the process running the generation is still alive to notice the
 *  flag. If it died (e.g. a server restart mid-run), nothing would ever act on it and the
 *  row would stay 'running' forever — reattaching as "still running" on every refresh and
 *  blocking new runs for the plan. So after flipping the flag, wait briefly for the job to
 *  leave 'running' on its own; if it doesn't, force-finalize it as 'canceled' here instead. */
export async function cancelTakeoffHandler(req: Request, res: Response): Promise<void> {
  const user = await getUserFromAuthHeader(req.headers.authorization ?? '');
  if (!user) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  const { plan_id } = (req.body ?? {}) as { plan_id?: string };
  if (!plan_id) {
    res.status(400).json({ error: 'plan_id is required.' });
    return;
  }

  const { data: job, error } = await supabaseAdmin
    .from('takeoff_jobs')
    .update({ cancel_requested: true, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('plan_id', plan_id)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[cancel-takeoff] update failed:', error.message);
    res.status(500).json({ error: 'Failed to cancel takeoff.' });
    return;
  }
  if (!job) {
    // Nothing running for this plan — already finished, errored, or canceled elsewhere.
    res.json({ ok: true });
    return;
  }

  const deadline = Date.now() + CANCEL_GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(CANCEL_POLL_MS);
    const { data: current } = await supabaseAdmin
      .from('takeoff_jobs')
      .select('status')
      .eq('id', job.id)
      .single();
    if (current?.status !== 'running') {
      res.json({ ok: true });
      return;
    }
  }

  // Still 'running' after the grace period: the owning process is gone. The status guard
  // avoids clobbering a legitimate finish that lands between our last poll and this update.
  await supabaseAdmin
    .from('takeoff_jobs')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'running');
  res.json({ ok: true });
}
