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

export async function generateTakeoffHandler(req: Request, res: Response): Promise<void> {
  // NDJSON streaming: one JSON object per line. Disable buffering so chunks reach the
  // client immediately (X-Accel-Buffering defeats nginx proxy buffering if present).
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

  let currentPhase: Phase | null = null;
  const setPhase = (phase: Phase) => {
    if (phase !== currentPhase) {
      currentPhase = phase;
      write({ type: 'phase', phase });
    }
  };

  // Heartbeat: a blank line every 10s keeps the stream alive during quiet stretches
  // (notably the 'saving' DB write), defeating idle/proxy timeouts.
  const heartbeat = setInterval(() => {
    try { res.write('\n'); } catch { /* socket closed */ }
  }, 10000);

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
      max_tokens: 32000,
      tool_choice: { type: 'auto' },
      tools: [
        {
          name: 'submit_takeoff',
          description: 'Submit the completed quantity takeoff for this project.',
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
                          unit: { type: 'string' },
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
            },
            required: ['projectName', 'summary', 'areas', 'sections', 'gaps'],
            additionalProperties: false,
          },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            {
              type: 'text',
              text: `You are an experienced construction quantity surveyor and estimator.

Analyze the architectural plans provided and generate a complete quantity takeoff.

${tradesClause}

As you work through each trade, briefly narrate what you're doing: which sheets you're referencing, how you're deriving quantities, and key assumptions. Keep this commentary tight — a few lines per trade, not paragraphs. Reserve most of your output for the structured tool call.

For each line item, classify the source:
- "stated" — the quantity is explicitly called out on the plans (e.g., a schedule or note gives the count)
- "derived" — the quantity was calculated from plan dimensions (e.g., area from room footprint)
- "estimated" — the quantity was estimated based on typical construction practice (e.g., rough-in counts per fixture)

Identify gaps where information is missing or ambiguous — things a contractor would need to clarify before confidently pricing the job.

Once your analysis is complete, call submit_takeoff with all the structured results.`,
            },
          ],
        },
      ],
    });

    // Forward narration tokens and, once the model switches to the submit_takeoff
    // tool JSON, surface trades as they're captured. inputJson's snapshot is the
    // progressively-parsed tool input (the raw partial_json isn't parseable mid-stream).
    let lastProgressKey = '';
    claudeStream
      .on('text', (delta) => {
        setPhase('analyzing');
        if (delta) write({ type: 'token', text: delta });
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
        }
      })
      .on('error', (err) => console.error('[generate-takeoff] stream error:', err));

    const finalMessage = await claudeStream.finalMessage();

    const toolUse = finalMessage.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      const reason = finalMessage.stop_reason === 'max_tokens'
        ? 'The plan was too large to complete in one pass. Please try fewer trades at a time.'
        : 'Model did not produce takeoff data.';
      write({ type: 'error', error: reason });
      return;
    }

    const takeoffData = toolUse.input as {
      projectName: string;
      summary: string;
      areas: { name: string; squareFeet: number }[];
      sections: { trade: string; items: unknown[] }[];
      gaps: { trade: string; description: string }[];
    };

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

    write({ type: 'done', takeoff: savedTakeoff });
  } catch (err) {
    console.error('[generate-takeoff] uncaught error:', err);
    const message = err instanceof Error ? err.message : 'Unexpected error.';
    write({ type: 'error', error: message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
