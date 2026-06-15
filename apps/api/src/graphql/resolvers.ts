import { GraphQLError } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { getAnthropic, CLAUDE_MODEL } from '../lib/anthropic';
import { trackUsage } from '../track-usage';
import { generateBidPdf, type BidTakeoffData } from '../bid-pdf';
import { requireUser, type GqlContext } from './context';

const bad = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_REQUEST' } });

// ── clarifyTakeoff ──────────────────────────────────────────────────────────
async function clarifyTakeoff(
  _: unknown,
  args: { takeoffId: string; clarifications: { gap: string; clarification: string }[] },
  ctx: GqlContext,
) {
  const user = await requireUser(ctx);
  const { takeoffId, clarifications } = args;
  if (!takeoffId || !Array.isArray(clarifications) || clarifications.length === 0) {
    throw bad('takeoffId and a non-empty clarifications array are required.');
  }

  const { data: takeoff, error: takeoffError } = await ctx.supabase
    .from('takeoffs')
    .select('id, plan_id, data')
    .eq('id', takeoffId)
    .eq('user_id', user.id)
    .single();
  if (takeoffError || !takeoff) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });

  const clarificationList = clarifications
    .map((c, i) => `Gap ${i + 1}: "${c.gap}"\nClarification: "${c.clarification}"`)
    .join('\n\n');

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: `You are a construction estimator revising a quantity takeoff with multiple newly clarified pieces of information.

The following gaps have been resolved by the user:

${clarificationList}

Current takeoff (sections and gaps only):
${JSON.stringify({ sections: takeoff.data.sections, gaps: takeoff.data.gaps }, null, 2)}

Instructions:
- Update all line items affected by any of the clarifications above.
- Set source to "stated" if the user gave an explicit value, or "derived" if you computed it from their input.
- Return the complete updated section (every item, not just changed ones) for each section that changed.
- Only include sections where something actually changed.
- resolvedGaps must be an array containing the EXACT gap strings, character-for-character, for every gap you resolved.

Respond with ONLY this JSON — no markdown, no prose:
{"updatedSections":[],"resolvedGaps":[]}`,
      },
    ],
  });

  if (message.stop_reason === 'refusal') {
    throw new GraphQLError('The model declined to process this request.', { extensions: { code: 'UNPROCESSABLE' } });
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new GraphQLError('No response from model.');

  let text = textBlock.text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const result = JSON.parse(text) as {
    updatedSections: { trade: string; items: unknown[] }[];
    resolvedGaps: string[];
  };

  // Merge updated sections and remove resolved gaps from persisted data.
  const updatedData = structuredClone(takeoff.data);
  for (const section of result.updatedSections ?? []) {
    const idx = updatedData.sections.findIndex((s: { trade: string }) => s.trade === section.trade);
    if (idx >= 0) updatedData.sections[idx] = section;
    else updatedData.sections.push(section);
  }
  const resolvedSet = new Set(result.resolvedGaps ?? []);
  updatedData.gaps = updatedData.gaps.filter((g: string) => !resolvedSet.has(g));

  await ctx.supabase.from('takeoffs').update({ data: updatedData }).eq('id', takeoffId);

  await trackUsage(ctx.supabase, {
    user_id: user.id,
    plan_id: takeoff.plan_id,
    takeoff_id: takeoff.id,
    operation: 'clarify-takeoff',
    model: CLAUDE_MODEL,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
  });

  return { updatedSections: result.updatedSections, resolvedGaps: result.resolvedGaps };
}

// ── getLocalPricing ─────────────────────────────────────────────────────────
async function getLocalPricing(
  _: unknown,
  args: { zipCode: string; lineItems: { trade: string; description: string; unit: string }[]; takeoffId?: string },
  ctx: GqlContext,
): Promise<Record<string, number>> {
  const user = await requireUser(ctx);
  const { zipCode, lineItems, takeoffId } = args;
  if (!zipCode?.trim()) throw bad('zipCode is required.');
  if (!lineItems?.length) throw bad('lineItems is required.');

  // Resolve plan_id from takeoff if provided (service role — works for subs too).
  let plan_id: string | null = null;
  if (takeoffId) {
    const { data: takeoff } = await ctx.supabase.from('takeoffs').select('plan_id').eq('id', takeoffId).single();
    if (takeoff) plan_id = takeoff.plan_id;
  }

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    tools: [
      {
        name: 'submit_pricing',
        description: 'Submit estimated installed unit prices for each line item.',
        input_schema: {
          type: 'object' as const,
          properties: {
            prices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  trade: { type: 'string' },
                  description: { type: 'string' },
                  unitPrice: { type: 'number', description: 'Estimated installed price in USD' },
                },
                required: ['trade', 'description', 'unitPrice'],
                additionalProperties: false,
              },
            },
          },
          required: ['prices'],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_pricing' },
    messages: [
      {
        role: 'user',
        content: `You are a professional construction cost estimator with deep knowledge of regional labor and material markets across the United States.

Estimate current (2025) market unit prices for the following construction line items in the region near ZIP code ${zipCode}. Prices should be installed costs (labor + materials combined) at the subcontractor level — what a general contractor would realistically pay.

Adjust for local cost-of-living, union vs. open-shop norms, and regional material availability. Be specific to the geography: coastal metros cost more, rural areas cost less. Do not use national averages.

Line items to price:
${lineItems.map((item, i) => `${i + 1}. [${item.trade}] ${item.description} (per ${item.unit})`).join('\n')}

Use the submit_pricing tool to return your estimates. Return a price for every item.`,
      },
    ],
  });

  if (message.stop_reason === 'max_tokens') {
    throw bad('Response was too large to complete. Try pricing fewer line items at once.');
  }

  const toolBlock = message.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') throw new GraphQLError('No pricing was produced.');

  const { prices } = toolBlock.input as {
    prices: Array<{ trade: string; description: string; unitPrice: number }>;
  };
  if (!Array.isArray(prices)) throw new GraphQLError('Model returned malformed pricing data.');

  await trackUsage(ctx.supabase, {
    user_id: user.id,
    plan_id,
    takeoff_id: takeoffId ?? null,
    operation: 'get-local-pricing',
    model: CLAUDE_MODEL,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
  });

  // Map to bidKey -> price using a case-insensitive lookup from the original line_items
  // so returned keys match what the client builds with bidKey(trade, description).
  const itemByDesc = new Map<string, { trade: string; description: string }>();
  for (const item of lineItems) itemByDesc.set(item.description.toLowerCase(), item);

  const result: Record<string, number> = {};
  for (const p of prices) {
    const desc = p.description.replace(/ \(per [^)]+\)$/, '');
    const original = itemByDesc.get(desc.toLowerCase());
    const trade = original?.trade ?? p.trade;
    const description = original?.description ?? desc;
    result[`${trade}::${description}`] = p.unitPrice;
  }

  return result;
}

// ── saveSubPrices ───────────────────────────────────────────────────────────
async function saveSubPrices(
  _: unknown,
  args: {
    takeoffId: string;
    delegations: Record<string, { prices: Record<string, number>; aiPrices?: Record<string, number>; manualPrices?: Record<string, number> }>;
  },
  ctx: GqlContext,
) {
  const user = await requireUser(ctx);
  const { takeoffId, delegations: subDelegations } = args;
  if (!takeoffId || !subDelegations) throw bad('takeoffId and delegations are required.');

  const { data: subs, error: subsError } = await ctx.supabase
    .from('subcontractors')
    .select('id')
    .eq('linked_user_id', user.id);
  if (subsError) throw new GraphQLError(subsError.message);

  const mySubIds = new Set((subs ?? []).map((s) => s.id as string));
  if (mySubIds.size === 0) {
    throw new GraphQLError('User is not linked to any subcontractor records.', { extensions: { code: 'FORBIDDEN' } });
  }

  const { data: row, error: fetchError } = await ctx.supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = row.data as any;
  const delegations = data?.bid?.delegations as Record<string, { subId: string }> | undefined;
  if (!delegations) throw bad('No delegations on this takeoff.');

  for (const trade of Object.keys(subDelegations)) {
    const del = delegations[trade];
    if (!del) throw new GraphQLError(`Trade "${trade}" is not delegated on this takeoff.`, { extensions: { code: 'FORBIDDEN' } });
    if (!mySubIds.has(del.subId)) {
      throw new GraphQLError(`Not authorized for trade "${trade}".`, { extensions: { code: 'FORBIDDEN' } });
    }
  }

  for (const [trade, update] of Object.entries(subDelegations)) {
    data.bid.delegations[trade].prices = update.prices;
    if (update.aiPrices !== undefined) data.bid.delegations[trade].aiPrices = update.aiPrices;
    if (update.manualPrices !== undefined) data.bid.delegations[trade].manualPrices = update.manualPrices;
  }

  const { error: updateError } = await ctx.supabase.from('takeoffs').update({ data }).eq('id', takeoffId);
  if (updateError) throw new GraphQLError(updateError.message);

  return { ok: true };
}

// ── approveSubBid ───────────────────────────────────────────────────────────
async function approveSubBid(
  _: unknown,
  args: { takeoffId: string; trades: string[] },
  ctx: GqlContext,
) {
  const user = await requireUser(ctx);
  const { takeoffId, trades } = args;
  if (!takeoffId || !Array.isArray(trades) || trades.length === 0) throw bad('takeoffId and trades are required.');

  const { data: subs, error: subsError } = await ctx.supabase
    .from('subcontractors')
    .select('id')
    .eq('linked_user_id', user.id);
  if (subsError) throw new GraphQLError(subsError.message);

  const mySubIds = new Set((subs ?? []).map((s) => s.id as string));
  if (mySubIds.size === 0) {
    throw new GraphQLError('User is not linked to any subcontractor records.', { extensions: { code: 'FORBIDDEN' } });
  }

  const { data: row, error: fetchError } = await ctx.supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = row.data as any;
  const delegations = data?.bid?.delegations as Record<string, { subId: string; approvedAt?: string }> | undefined;
  if (!delegations) throw bad('No delegations on this takeoff.');

  for (const trade of trades) {
    const del = delegations[trade];
    if (!del) throw new GraphQLError(`Trade "${trade}" is not delegated on this takeoff.`, { extensions: { code: 'FORBIDDEN' } });
    if (!mySubIds.has(del.subId)) {
      throw new GraphQLError(`Not authorized for trade "${trade}".`, { extensions: { code: 'FORBIDDEN' } });
    }
  }

  const approvedAt = new Date().toISOString();
  for (const trade of trades) data.bid.delegations[trade].approvedAt = approvedAt;

  const { error: updateError } = await ctx.supabase.from('takeoffs').update({ data }).eq('id', takeoffId);
  if (updateError) throw new GraphQLError(updateError.message);

  return { ok: true, approvedAt };
}

// ── shareBidPdf ─────────────────────────────────────────────────────────────
async function shareBidPdf(
  _: unknown,
  args: { takeoffId: string; email?: string; phone?: string; sharingMode?: 'full' | 'summary' },
  ctx: GqlContext,
) {
  const user = await requireUser(ctx);
  const { takeoffId, email, phone, sharingMode } = args;
  if (!takeoffId) throw bad('takeoffId is required.');
  if (!email && !phone) throw bad('At least one of email or phone is required.');

  const { data: row, error: fetchError } = await ctx.supabase
    .from('takeoffs')
    .select('data')
    .eq('id', takeoffId)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !row) throw new GraphQLError('Takeoff not found or access denied.', { extensions: { code: 'NOT_FOUND' } });

  const data = row.data as BidTakeoffData;
  if (!data.bid?.finalizedAt) throw bad('Bid must be finalized before sharing.');

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateBidPdf(data, sharingMode ?? 'full');
  } catch (err) {
    console.error('[shareBidPdf] PDF generation failed:', err);
    throw new GraphQLError('Failed to generate PDF.');
  }

  const errors: string[] = [];
  const safeName = data.projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  // ── Email via Resend ──
  if (email) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      errors.push('Email sending is not configured (missing RESEND_API_KEY).');
    } else {
      const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'BidWise <onboarding@resend.dev>';
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromEmail,
          to: [email],
          subject: `Bid Proposal: ${data.projectName}`,
          html: `<!DOCTYPE html><html><body style="margin:0;padding:32px 0;background:#f8fafc;font-family:sans-serif;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:40px 48px;">
  <div style="text-align:center;margin-bottom:32px;">
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:10px;">
      <rect width="48" height="48" rx="12" fill="#2563eb"/>
      <path d="M13 25.5 L20.5 33 L35 17" stroke="white" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span style="display:inline-block;vertical-align:middle;font-size:28px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Bid<span style="color:#2563eb;">Wise</span></span>
  </div>
  <p style="color:#374151;font-size:15px;line-height:1.6;margin:0;">Please find the bid proposal for <strong>${data.projectName}</strong> attached.</p>
</div>
</body></html>`,
          attachments: [{ filename: `bid-proposal-${safeName}.pdf`, content: pdfBase64 }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error('[shareBidPdf] Resend error:', res.status, body);
        errors.push(`Email send failed: ${res.status}`);
      }
    }
  }

  // ── SMS via Telnyx ──
  if (phone) {
    const telnyxKey = process.env.TELNYX_API_KEY;
    const telnyxFrom = process.env.TELNYX_FROM_NUMBER;
    if (!telnyxKey || !telnyxFrom) {
      errors.push('SMS sending is not configured (missing TELNYX_API_KEY or TELNYX_FROM_NUMBER).');
    } else {
      const fileName = `${takeoffId}.pdf`;
      await ctx.supabase.storage.from('bid-pdfs').upload(fileName, pdfBytes, {
        contentType: 'application/pdf',
        upsert: true,
      });
      const { data: urlData } = ctx.supabase.storage.from('bid-pdfs').getPublicUrl(fileName);
      const pdfUrl = urlData.publicUrl;

      const res = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${telnyxKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: telnyxFrom,
          to: phone,
          text: `Your bid proposal for ${data.projectName} is ready: ${pdfUrl}`,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error('[shareBidPdf] Telnyx error:', res.status, body);
        errors.push(`SMS send failed: ${res.status}`);
      }
    }
  }

  if (errors.length > 0) throw new GraphQLError(errors.join(' '));

  // Record that the bid was sent to the customer. This locks the project from new takeoffs.
  if (data.bid) {
    data.bid.sentAt = new Date().toISOString();
    await ctx.supabase.from('takeoffs').update({ data }).eq('id', takeoffId);
  }

  return { ok: true };
}

export const resolvers = {
  JSON: GraphQLJSON,
  Query: {
    hello: () => 'Hello from Apollo Server!',
  },
  Mutation: {
    clarifyTakeoff,
    getLocalPricing,
    saveSubPrices,
    approveSubBid,
    shareBidPdf,
  },
};
