import { GraphQLError } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { getAnthropic, CLAUDE_MODEL } from '../lib/anthropic';
import { trackUsage } from '../track-usage';
import { generateBidPdf, type BidTakeoffData } from '../bid-pdf';
import { getStripe, appUrl } from '../lib/stripe';
import {
  totalSquareFeetRaw,
  priceCentsForSquareFeet,
  displaySquareFeet,
  INVALID_SQUARE_FEET_MESSAGE,
  MONTHLY_PLAN_PRICE_CENTS,
} from '../lib/pricing';
import {
  getBalanceCents,
  isTakeoffPaid,
  creditTopup,
  getBillingCustomer,
  ensureStripeCustomerId,
  persistCardFromSetupIntent,
  setAutoTopup,
  removeSavedCard as removeSavedCardRow,
  runAutoTopupIfNeeded,
  hasActiveMonthlySubscription,
  syncSubscriptionFromStripe,
  type BillingCustomer,
} from '../billing';
import { requireUser, requireCompanyMember, requireCompanyOwner, type GqlContext } from './context';

const bad = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_REQUEST' } });

const UNIQUE_VIOLATION = '23505';

const invalidSquareFeet = () =>
  new GraphQLError(INVALID_SQUARE_FEET_MESSAGE, { extensions: { code: 'INVALID_SQUARE_FOOTAGE' } });

/** Blocks Materials/Pricing/Bid-adjacent resolvers until the takeoff has been paid for. */
async function requirePaid(ctx: GqlContext, takeoffId: string): Promise<void> {
  if (!(await isTakeoffPaid(ctx.supabase, takeoffId))) {
    throw new GraphQLError('This bid must be paid for before continuing — pay from the Takeoff tab first.', {
      extensions: { code: 'PAYMENT_REQUIRED' },
    });
  }
}

/** Resolves the current user and throws FORBIDDEN unless their app_metadata carries the SuperAdmin role. */
async function requireSuperAdmin(ctx: GqlContext) {
  const user = await requireUser(ctx);
  const roles = (user.app_metadata?.roles ?? []) as string[];
  if (!roles.includes('SuperAdmin')) {
    throw new GraphQLError('Not authorized.', { extensions: { code: 'FORBIDDEN' } });
  }
  return user;
}

// Despite being asked for JSON only, the model sometimes prepends narration ("I'll ...")
// or wraps the reply in a markdown fence. Slice out the outermost {...} rather than
// assuming the whole text block is clean JSON.
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new GraphQLError('Model response did not contain JSON.');
  }
  return text.slice(start, end + 1);
}

// ── clarifyTakeoff ──────────────────────────────────────────────────────────
type ClarificationFile = { name: string; mediaType: string; data: string };

// Image media types Claude accepts as image blocks; everything else is treated as a document (PDF).
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Resolve a usable media type, inferring from the file extension when the client didn't supply one.
function resolveMediaType(file: ClarificationFile): string {
  if (file.mediaType) return file.mediaType;
  const ext = file.name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return 'application/pdf';
  }
}

// Build the Anthropic content block for an attached clarification file.
function fileBlock(file: ClarificationFile) {
  const mediaType = resolveMediaType(file);
  if (IMAGE_MEDIA_TYPES.has(mediaType)) {
    return { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: file.data } };
  }
  return { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: file.data } };
}

async function clarifyTakeoff(
  _: unknown,
  args: { takeoffId: string; clarifications: { gap: string; clarification: string; file?: ClarificationFile | null }[] },
  ctx: GqlContext,
) {
  const { takeoffId, clarifications } = args;
  if (!takeoffId || !Array.isArray(clarifications) || clarifications.length === 0) {
    throw bad('takeoffId and a non-empty clarifications array are required.');
  }

  const { data: takeoff, error: takeoffError } = await ctx.supabase
    .from('takeoffs')
    .select('id, plan_id, company_id, data')
    .eq('id', takeoffId)
    .single();
  if (takeoffError || !takeoff) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });
  const { user } = await requireCompanyMember(ctx, takeoff.company_id);

  // Interleave each gap's clarification (and any attached file) so the model can tie an
  // uploaded spec sheet / photo / PDF to the specific gap it resolves.
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `You are a construction estimator revising a quantity takeoff with multiple newly clarified pieces of information.

The following gaps have been resolved by the user:`,
    },
  ];
  clarifications.forEach((c, i) => {
    content.push({
      type: 'text',
      text: `Gap ${i + 1}: "${c.gap}"\nClarification: "${c.clarification || '(see attached file)'}"`,
    });
    if (c.file?.data) {
      content.push({
        type: 'text',
        text: `Attached file for Gap ${i + 1} ("${c.file.name}") — read it and extract the value(s) needed to resolve this gap:`,
      });
      content.push(fileBlock(c.file));
    }
  });
  content.push({
    type: 'text',
    text: `Current takeoff (sections and gaps only):
${JSON.stringify({ sections: takeoff.data.sections, gaps: takeoff.data.gaps }, null, 2)}

Instructions:
- Update all line items affected by any of the clarifications above.
- When a gap has an attached file, read the file to determine the correct value.
- Set source to "stated" if the user (or the attached file) gave an explicit value, or "derived" if you computed it from their input.
- Return the complete updated section (every item, not just changed ones) for each section that changed.
- Only include sections where something actually changed.
- resolvedGaps must be an array containing the EXACT gap strings, character-for-character, for every gap you resolved.

Respond with ONLY this JSON — no markdown, no prose:
{"updatedSections":[],"resolvedGaps":[]}`,
  });

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: content as any }],
  });

  if (message.stop_reason === 'refusal') {
    throw new GraphQLError('The model declined to process this request.', { extensions: { code: 'UNPROCESSABLE' } });
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new GraphQLError('No response from model.');

  const result = JSON.parse(extractJsonObject(textBlock.text)) as {
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
    company_id: takeoff.company_id,
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

// ── recalculateMaterials ─────────────────────────────────────────────────────
async function recalculateMaterials(
  _: unknown,
  args: { takeoffId: string },
  ctx: GqlContext,
) {
  const { takeoffId } = args;
  if (!takeoffId) throw bad('takeoffId is required.');

  const { data: takeoff, error: takeoffError } = await ctx.supabase
    .from('takeoffs')
    .select('id, plan_id, company_id, data')
    .eq('id', takeoffId)
    .single();
  if (takeoffError || !takeoff) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });
  const { user } = await requireCompanyMember(ctx, takeoff.company_id);

  type LineItem = { description: string; quantity: number; unit: string; source: string; notes?: string };
  const sections = (takeoff.data.sections ?? []) as { trade: string; items: LineItem[] }[];

  const annotated = sections
    .map((s) => ({ trade: s.trade, items: s.items.filter((it) => it.notes?.trim()) }))
    .filter((s) => s.items.length > 0);
  const consideredCount = annotated.reduce((sum, s) => sum + s.items.length, 0);
  if (consideredCount === 0) {
    throw bad('No line-item assumptions to recalculate. Add a note to a line item first.');
  }

  const prompt = `You are a construction estimator revising a quantity takeoff. The contractor has added notes/assumptions to specific line items — use each note to recompute that item's quantity (and unit/source, if the note changes the reasoning).

Line items with a user-added assumption:
${JSON.stringify(annotated, null, 2)}

Full current takeoff, for context (areas and all sections/items):
${JSON.stringify({ areas: takeoff.data.areas, sections: takeoff.data.sections }, null, 2)}

Instructions:
- Recompute the quantity (and unit/source if warranted) for every item listed above under "Line items with a user-added assumption", based on its note.
- Set source to "stated" if the note gives an explicit value, or "derived" if you computed it from the note.
- Leave every other item in each section completely unchanged.
- Return the complete updated section (every item, not just the recomputed ones) for each section that contains at least one recomputed item.
- Only include sections where something actually changed.

Respond with ONLY this JSON — no markdown, no prose:
{"updatedSections":[]}`;

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  if (message.stop_reason === 'refusal') {
    throw new GraphQLError('The model declined to process this request.', { extensions: { code: 'UNPROCESSABLE' } });
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new GraphQLError('No response from model.');

  const result = JSON.parse(extractJsonObject(textBlock.text)) as {
    updatedSections: { trade: string; items: unknown[] }[];
  };

  const updatedData = structuredClone(takeoff.data);
  for (const section of result.updatedSections ?? []) {
    const idx = updatedData.sections.findIndex((s: { trade: string }) => s.trade === section.trade);
    if (idx >= 0) updatedData.sections[idx] = section;
    else updatedData.sections.push(section);
  }

  await ctx.supabase.from('takeoffs').update({ data: updatedData }).eq('id', takeoffId);

  await trackUsage(ctx.supabase, {
    user_id: user.id,
    company_id: takeoff.company_id,
    plan_id: takeoff.plan_id,
    takeoff_id: takeoff.id,
    operation: 'recalculate-materials',
    model: CLAUDE_MODEL,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
  });

  return { updatedSections: result.updatedSections, consideredCount };
}

// ── getLocalPricing ─────────────────────────────────────────────────────────
async function getLocalPricing(
  _: unknown,
  args: { zipCode: string; lineItems: { trade: string; description: string; unit: string }[]; takeoffId?: string },
  ctx: GqlContext,
): Promise<{ prices: Record<string, { material: number; labor: number }>; totalTokens: number }> {
  const user = await requireUser(ctx);
  const { zipCode, lineItems, takeoffId } = args;
  if (!zipCode?.trim()) throw bad('zipCode is required.');
  if (!lineItems?.length) throw bad('lineItems is required.');

  // Resolve plan_id from takeoff if provided. Also closes a prior gap where this resolver
  // never verified the caller could access the takeoff at all — only that it was paid.
  let plan_id: string | null = null;
  let company_id: string | null = null;
  if (takeoffId) {
    const { data: takeoff } = await ctx.supabase
      .from('takeoffs')
      .select('plan_id, company_id')
      .eq('id', takeoffId)
      .maybeSingle();
    if (!takeoff) throw new GraphQLError('Takeoff not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireCompanyMember(ctx, takeoff.company_id);
    await requirePaid(ctx, takeoffId);
    plan_id = takeoff.plan_id;
    company_id = takeoff.company_id;
  }

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    tools: [
      {
        name: 'submit_pricing',
        description: 'Submit estimated material and labor unit costs for each line item.',
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
                  materialPrice: { type: 'number', description: 'Estimated material/supply cost per unit, in USD' },
                  laborPrice: { type: 'number', description: 'Estimated installed labor cost per unit, in USD' },
                },
                required: ['trade', 'description', 'materialPrice', 'laborPrice'],
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

Estimate current (2025) market unit costs for the following construction line items in the region near ZIP code ${zipCode}, at the subcontractor level — what a general contractor would realistically pay. For each item give TWO separate numbers:
- materialPrice: the supplied material cost per unit (the materials/goods only).
- laborPrice: the installed labor cost per unit (crew labor including labor burden and typical equipment to install it).
The installed price is material + labor; keep the two components separate.

Adjust for local cost-of-living, union vs. open-shop norms, and regional material availability. Be specific to the geography: coastal metros cost more, rural areas cost less. Do not use national averages. For pure-labor items use materialPrice 0; for material-only allowances use laborPrice 0.

Line items to price:
${lineItems.map((item, i) => `${i + 1}. [${item.trade}] ${item.description} (per ${item.unit})`).join('\n')}

Use the submit_pricing tool to return your estimates. Return both numbers for every item.`,
      },
    ],
  });

  if (message.stop_reason === 'max_tokens') {
    throw bad('Response was too large to complete. Try pricing fewer line items at once.');
  }

  const toolBlock = message.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') throw new GraphQLError('No pricing was produced.');

  const { prices } = toolBlock.input as {
    prices: Array<{ trade: string; description: string; materialPrice: number; laborPrice: number }>;
  };
  if (!Array.isArray(prices)) throw new GraphQLError('Model returned malformed pricing data.');

  const cacheCreation = message.usage.cache_creation_input_tokens ?? 0;
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const totalTokens =
    message.usage.input_tokens + message.usage.output_tokens + cacheCreation + cacheRead;

  await trackUsage(ctx.supabase, {
    user_id: user.id,
    company_id,
    plan_id,
    takeoff_id: takeoffId ?? null,
    operation: 'get-local-pricing',
    model: CLAUDE_MODEL,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  });

  // Map to bidKey -> price using a case-insensitive lookup from the original line_items
  // so returned keys match what the client builds with bidKey(trade, description).
  const itemByDesc = new Map<string, { trade: string; description: string }>();
  for (const item of lineItems) itemByDesc.set(item.description.toLowerCase(), item);

  const result: Record<string, { material: number; labor: number }> = {};
  for (const p of prices) {
    const desc = p.description.replace(/ \(per [^)]+\)$/, '');
    const original = itemByDesc.get(desc.toLowerCase());
    const trade = original?.trade ?? p.trade;
    const description = original?.description ?? desc;
    result[`${trade}::${description}`] = {
      material: p.materialPrice ?? 0,
      labor: p.laborPrice ?? 0,
    };
  }

  return { prices: result, totalTokens };
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
  await requirePaid(ctx, takeoffId);

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
  await requirePaid(ctx, takeoffId);

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

/** Sends an email via Resend. Returns an error message string on failure, or null on success. */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  attachments?: { filename: string; content: string }[],
): Promise<string | null> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return 'Email sending is not configured (missing RESEND_API_KEY).';
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'BidWise <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html, ...(attachments ? { attachments } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[sendEmail] Resend error:', res.status, body);
    return `Email send failed: ${res.status}`;
  }
  return null;
}

// ── shareBidPdf ─────────────────────────────────────────────────────────────
async function shareBidPdf(
  _: unknown,
  args: { takeoffId: string; email?: string; phone?: string; sharingMode?: 'full' | 'summary' },
  ctx: GqlContext,
) {
  const { takeoffId, email, phone, sharingMode } = args;
  if (!takeoffId) throw bad('takeoffId is required.');
  if (!email && !phone) throw bad('At least one of email or phone is required.');

  const { data: row, error: fetchError } = await ctx.supabase
    .from('takeoffs')
    .select('company_id, data')
    .eq('id', takeoffId)
    .single();
  if (fetchError || !row) throw new GraphQLError('Takeoff not found or access denied.', { extensions: { code: 'NOT_FOUND' } });
  await requireCompanyMember(ctx, row.company_id);
  await requirePaid(ctx, takeoffId);

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
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
    const emailError = await sendEmail(
      email,
      `Bid Proposal: ${data.projectName}`,
      `<!DOCTYPE html><html><body style="margin:0;padding:32px 0;background:#f8fafc;font-family:sans-serif;">
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
      [{ filename: `bid-proposal-${safeName}.pdf`, content: pdfBase64 }],
    );
    if (emailError) errors.push(emailError);
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

// ── Companies / team ─────────────────────────────────────────────────────────

interface CompanyRow {
  id: string;
  name: string;
  billing_email: string | null;
  created_at: string;
}

function toCompany(row: CompanyRow) {
  return { id: row.id, name: row.name, billingEmail: row.billing_email, createdAt: row.created_at };
}

interface CompanyInviteRow {
  id: string;
  company_id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  /** Only ever selected (and thus populated) for myPendingInvites, which is already scoped
   *  to the caller's own verified email — never selected for companyInvites' owner-facing
   *  roster, so the token isn't broadcast beyond the invitee and the inviter who created it. */
  token?: string;
}

function toCompanyInvite(row: CompanyInviteRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    token: row.token ?? null,
  };
}

async function myCompanies(_: unknown, __: unknown, ctx: GqlContext) {
  const user = await requireUser(ctx);
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('role, companies(id, name, billing_email, created_at)')
    .eq('user_id', user.id);
  if (error) throw error;

  return ((data ?? []) as unknown as { role: string; companies: CompanyRow | null }[])
    .filter((m) => m.companies)
    .map((m) => ({ role: m.role, company: toCompany(m.companies as CompanyRow) }));
}

async function companyMembers(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  await requireCompanyMember(ctx, companyId);
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('user_id, role, joined_at')
    .eq('company_id', companyId)
    .order('joined_at', { ascending: true });
  if (error) throw error;

  return Promise.all(
    (data ?? []).map(async (m) => {
      const { data: userData } = await ctx.supabase.auth.admin.getUserById(m.user_id as string);
      return {
        userId: m.user_id,
        email: userData?.user?.email ?? 'unknown',
        role: m.role,
        joinedAt: m.joined_at,
      };
    }),
  );
}

async function companyInvites(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  await requireCompanyMember(ctx, companyId);
  const { data, error } = await ctx.supabase
    .from('company_invites')
    .select('id, company_id, email, role, status, created_at, expires_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as CompanyInviteRow[]).map(toCompanyInvite);
}

async function myPendingInvites(_: unknown, __: unknown, ctx: GqlContext) {
  const user = await requireUser(ctx);
  if (!user.email) return [];
  const { data, error } = await ctx.supabase
    .from('company_invites')
    .select('id, company_id, email, role, status, created_at, expires_at, token')
    .eq('status', 'pending')
    .eq('email', user.email.trim().toLowerCase())
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return ((data ?? []) as CompanyInviteRow[]).map(toCompanyInvite);
}

async function createCompany(_: unknown, { name }: { name: string }, ctx: GqlContext) {
  const user = await requireUser(ctx);
  const trimmed = name?.trim();
  if (!trimmed) throw bad('Company name is required.');

  const { data: companyId, error } = await ctx.supabase.rpc('create_company_with_owner', {
    p_name: trimmed,
    p_owner: user.id,
    p_owner_email: user.email ?? null,
  });
  if (error) throw error;

  const { data: company, error: fetchErr } = await ctx.supabase
    .from('companies')
    .select('id, name, billing_email, created_at')
    .eq('id', companyId)
    .single();
  if (fetchErr || !company) throw new GraphQLError('Failed to create company.');
  return toCompany(company);
}

async function renameCompany(
  _: unknown,
  { companyId, name }: { companyId: string; name: string },
  ctx: GqlContext,
) {
  await requireCompanyMember(ctx, companyId);
  const trimmed = name?.trim();
  if (!trimmed) throw bad('Company name is required.');

  const { data: company, error } = await ctx.supabase
    .from('companies')
    .update({ name: trimmed })
    .eq('id', companyId)
    .select('id, name, billing_email, created_at')
    .single();
  if (error || !company) throw new GraphQLError('Could not rename company.');
  return toCompany(company);
}

async function inviteTeamMember(
  _: unknown,
  { companyId, email }: { companyId: string; email: string },
  ctx: GqlContext,
) {
  const user = await requireCompanyOwner(ctx, companyId);
  const trimmedEmail = email?.trim().toLowerCase();
  if (!trimmedEmail || !trimmedEmail.includes('@')) throw bad('A valid email is required.');

  const { data: company } = await ctx.supabase.from('companies').select('name').eq('id', companyId).single();

  const { data: invite, error } = await ctx.supabase
    .from('company_invites')
    .insert({ company_id: companyId, email: trimmedEmail, invited_by: user.id })
    .select('id, company_id, email, role, status, created_at, expires_at, token')
    .single();
  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw bad('This email already has a pending invite for this company.');
    }
    throw error;
  }

  const acceptUrl = `${appUrl()}/accept-invite?token=${invite.token}`;
  const emailError = await sendEmail(
    trimmedEmail,
    `You've been invited to join ${company?.name ?? 'a company'} on Bid Wise`,
    `<!DOCTYPE html><html><body style="margin:0;padding:32px 0;background:#f8fafc;font-family:sans-serif;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:40px 48px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:28px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Bid<span style="color:#2563eb;">Wise</span></span>
  </div>
  <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">You've been invited to join <strong>${company?.name ?? 'a company'}</strong> on Bid Wise.</p>
  <p style="text-align:center;margin:0;">
    <a href="${acceptUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Accept invite</a>
  </p>
</div>
</body></html>`,
  );
  if (emailError) {
    // Delete rather than leave a dangling pending invite — the unique index on
    // (company_id, lower(email)) WHERE status='pending' would otherwise block a retry.
    await ctx.supabase.from('company_invites').delete().eq('id', invite.id);
    throw new GraphQLError(`Could not send invite email: ${emailError}`);
  }

  return toCompanyInvite(invite);
}

async function revokeInvite(_: unknown, { inviteId }: { inviteId: string }, ctx: GqlContext) {
  const { data: invite } = await ctx.supabase
    .from('company_invites')
    .select('id, company_id, status')
    .eq('id', inviteId)
    .maybeSingle();
  if (!invite) throw new GraphQLError('Invite not found.', { extensions: { code: 'NOT_FOUND' } });
  await requireCompanyOwner(ctx, invite.company_id);
  if (invite.status !== 'pending') throw bad('Only pending invites can be revoked.');

  const { error } = await ctx.supabase.from('company_invites').update({ status: 'revoked' }).eq('id', inviteId);
  if (error) throw error;
  return { ok: true };
}

async function acceptInvite(_: unknown, { token }: { token: string }, ctx: GqlContext) {
  const user = await requireUser(ctx);
  const { data: invite } = await ctx.supabase
    .from('company_invites')
    .select('id, company_id, email, role, status, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (!invite) throw new GraphQLError('Invite not found.', { extensions: { code: 'NOT_FOUND' } });
  if (invite.status !== 'pending') throw bad('This invite is no longer valid.');
  if (new Date(invite.expires_at).getTime() < Date.now()) throw bad('This invite has expired.');
  if (!user.email || user.email.trim().toLowerCase() !== invite.email.toLowerCase()) {
    throw new GraphQLError('This invite was sent to a different email address.', { extensions: { code: 'FORBIDDEN' } });
  }

  const { error: memberErr } = await ctx.supabase
    .from('company_members')
    .insert({ company_id: invite.company_id, user_id: user.id, role: invite.role });
  if (memberErr && (memberErr as { code?: string }).code !== UNIQUE_VIOLATION) throw memberErr;

  await ctx.supabase
    .from('company_invites')
    .update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('id', invite.id);

  const { data: company, error: companyErr } = await ctx.supabase
    .from('companies')
    .select('id, name, billing_email, created_at')
    .eq('id', invite.company_id)
    .single();
  if (companyErr || !company) throw new GraphQLError('Failed to load company.');
  return toCompany(company);
}

async function removeTeamMember(
  _: unknown,
  { companyId, userId }: { companyId: string; userId: string },
  ctx: GqlContext,
) {
  await requireCompanyOwner(ctx, companyId);
  const { error } = await ctx.supabase
    .from('company_members')
    .delete()
    .eq('company_id', companyId)
    .eq('user_id', userId);
  if (error) throw bad(error.message);
  return { ok: true };
}

// ── Billing / credits ────────────────────────────────────────────────────────

const MIN_TOPUP_CENTS = 500; // $5
const MAX_TOPUP_CENTS = 100_000; // $1,000

async function creditBalanceCents(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext): Promise<number> {
  await requireCompanyMember(ctx, companyId);
  return getBalanceCents(ctx.supabase, companyId);
}

function stripeTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');
}

async function bidQuote(
  _: unknown,
  { takeoffId }: { takeoffId: string },
  ctx: GqlContext,
): Promise<{ squareFeet: number; priceCents: number; alreadyPaid: boolean; balanceCents: number }> {
  const { data: takeoff } = await ctx.supabase
    .from('takeoffs')
    .select('id, company_id, data')
    .eq('id', takeoffId)
    .maybeSingle();
  if (!takeoff) throw bad('Takeoff not found.');
  await requireCompanyMember(ctx, takeoff.company_id);

  const alreadyPaid = await isTakeoffPaid(ctx.supabase, takeoffId);

  const rawSqFt = totalSquareFeetRaw((takeoff.data as { areas?: { squareFeet?: number }[] })?.areas);
  let priceCents = 0;
  if (!alreadyPaid) {
    const computed = priceCentsForSquareFeet(rawSqFt);
    if (computed == null) throw invalidSquareFeet();
    priceCents = computed;
  }

  return {
    squareFeet: displaySquareFeet(rawSqFt),
    priceCents,
    alreadyPaid,
    balanceCents: await getBalanceCents(ctx.supabase, takeoff.company_id),
  };
}

async function payForTakeoff(
  _: unknown,
  { takeoffId }: { takeoffId: string },
  ctx: GqlContext,
): Promise<{ balanceCents: number }> {
  const { data: takeoff } = await ctx.supabase
    .from('takeoffs')
    .select('id, company_id, data')
    .eq('id', takeoffId)
    .maybeSingle();
  if (!takeoff) throw bad('Takeoff not found.');
  const { user } = await requireCompanyMember(ctx, takeoff.company_id);

  const alreadyCovered = await isTakeoffPaid(ctx.supabase, takeoffId);

  if (!alreadyCovered) {
    const rawSqFt = totalSquareFeetRaw((takeoff.data as { areas?: { squareFeet?: number }[] })?.areas);
    const priceCents = priceCentsForSquareFeet(rawSqFt);
    if (priceCents == null) throw invalidSquareFeet();

    let balance = await getBalanceCents(ctx.supabase, takeoff.company_id);
    if (balance < priceCents) {
      // Give auto top-up a chance to cover the shortfall before declaring insufficient credits.
      await runAutoTopupIfNeeded(ctx.supabase, takeoff.company_id);
      balance = await getBalanceCents(ctx.supabase, takeoff.company_id);
    }
    if (balance < priceCents) {
      throw new GraphQLError('Not enough credits to unlock this bid.', {
        extensions: {
          code: 'INSUFFICIENT_CREDITS',
          squareFeet: displaySquareFeet(rawSqFt),
          priceCents,
          balanceCents: balance,
        },
      });
    }
    const { error: chargeErr } = await ctx.supabase.from('credit_transactions').insert({
      company_id: takeoff.company_id,
      actor_user_id: user.id,
      kind: 'charge',
      amount_cents: -priceCents,
      takeoff_id: takeoffId,
      tier: 'sqft',
    });
    // Unique violation → a concurrent payment already charged it; treat as success.
    if (chargeErr && (chargeErr as { code?: string }).code !== UNIQUE_VIOLATION) throw chargeErr;

    // This charge may have dropped the balance below the auto top-up threshold — replenish now.
    await runAutoTopupIfNeeded(ctx.supabase, takeoff.company_id);
  }

  return { balanceCents: await getBalanceCents(ctx.supabase, takeoff.company_id) };
}

async function createCreditCheckout(
  _: unknown,
  { amountCents, companyId }: { amountCents: number; companyId: string },
  ctx: GqlContext,
): Promise<{ url: string }> {
  const user = await requireCompanyOwner(ctx, companyId);
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    throw bad(`Top-up must be between $${MIN_TOPUP_CENTS / 100} and $${MAX_TOPUP_CENTS / 100}.`);
  }
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: 'Bid Wise credits' },
        },
      },
    ],
    metadata: { companyId, actorUserId: user.id, kind: 'credit_topup' },
    success_url: `${appUrl()}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing?canceled=1`,
  });
  if (!session.url) throw new GraphQLError('Stripe did not return a checkout URL.');
  return { url: session.url };
}

async function confirmTopup(
  _: unknown,
  { sessionId, companyId }: { sessionId: string; companyId: string },
  ctx: GqlContext,
): Promise<{ balanceCents: number }> {
  const user = await requireCompanyOwner(ctx, companyId);
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  if (session.payment_status === 'paid' && session.metadata?.companyId === companyId) {
    await creditTopup(ctx.supabase, {
      companyId,
      actorUserId: user.id,
      sessionId: session.id,
      amountCents: session.amount_total ?? 0,
    });
  }
  return { balanceCents: await getBalanceCents(ctx.supabase, companyId) };
}

function toBillingSettings(customer: BillingCustomer | null) {
  return {
    hasSavedCard: !!customer?.stripePaymentMethodId,
    cardBrand: customer?.cardBrand ?? null,
    cardLast4: customer?.cardLast4 ?? null,
    autoTopupEnabled: customer?.autoTopupEnabled ?? false,
    autoTopupThresholdCents: customer?.autoTopupThresholdCents ?? null,
    autoTopupTargetCents: customer?.autoTopupTargetCents ?? null,
    autoTopupDisabledReason: customer?.autoTopupDisabledReason ?? null,
    plan: customer?.plan ?? 'per_bid',
    subscriptionStatus: customer?.subscriptionStatus ?? null,
    subscriptionCancelAtPeriodEnd: customer?.subscriptionCancelAtPeriodEnd ?? false,
    subscriptionCurrentPeriodEnd: customer?.subscriptionCurrentPeriodEnd ?? null,
    monthlyPlanPriceCents: MONTHLY_PLAN_PRICE_CENTS,
  };
}

async function billingSettings(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  // Balance/plan are visible to any member (shared wallet) — only the mutations below are owner-gated.
  await requireCompanyMember(ctx, companyId);
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

// ── Monthly plan / subscription ──────────────────────────────────────────────

async function createSubscriptionCheckout(
  _: unknown,
  { companyId }: { companyId: string },
  ctx: GqlContext,
): Promise<{ url: string }> {
  const user = await requireCompanyOwner(ctx, companyId);
  if (hasActiveMonthlySubscription(await getBillingCustomer(ctx.supabase, companyId))) {
    throw bad('You already have an active monthly plan.');
  }
  const customerId = await ensureStripeCustomerId(ctx.supabase, companyId, user.id, user.email ?? undefined);
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: MONTHLY_PLAN_PRICE_CENTS,
          recurring: { interval: 'month' },
          product_data: { name: 'Bid Wise — Unlimited Monthly' },
        },
      },
    ],
    // Metadata on the subscription itself (not just the session) so the webhook can resolve
    // companyId directly from subscription.updated/deleted events without a customer lookup.
    subscription_data: { metadata: { companyId } },
    metadata: { companyId, actorUserId: user.id, kind: 'subscription' },
    success_url: `${appUrl()}/billing?sub_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing?sub_canceled=1`,
  });
  if (!session.url) throw new GraphQLError('Stripe did not return a checkout URL.');
  return { url: session.url };
}

async function confirmSubscriptionCheckout(
  _: unknown,
  { sessionId, companyId }: { sessionId: string; companyId: string },
  ctx: GqlContext,
) {
  await requireCompanyOwner(ctx, companyId);
  const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  if (
    session.metadata?.kind === 'subscription' &&
    session.metadata?.companyId === companyId &&
    session.subscription &&
    typeof session.subscription !== 'string'
  ) {
    await syncSubscriptionFromStripe(ctx.supabase, companyId, session.subscription);
  }
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function cancelSubscription(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  await requireCompanyOwner(ctx, companyId);
  const customer = await getBillingCustomer(ctx.supabase, companyId);
  if (!customer?.stripeSubscriptionId) throw bad('No active subscription to cancel.');
  const subscription = await getStripe().subscriptions.update(customer.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  await syncSubscriptionFromStripe(ctx.supabase, companyId, subscription);
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function resumeSubscription(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  await requireCompanyOwner(ctx, companyId);
  const customer = await getBillingCustomer(ctx.supabase, companyId);
  if (!customer?.stripeSubscriptionId) throw bad('No subscription to resume.');
  const subscription = await getStripe().subscriptions.update(customer.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });
  await syncSubscriptionFromStripe(ctx.supabase, companyId, subscription);
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function startCardSetup(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext): Promise<{ url: string }> {
  const user = await requireCompanyOwner(ctx, companyId);
  const customerId = await ensureStripeCustomerId(ctx.supabase, companyId, user.id, user.email ?? undefined);
  const session = await getStripe().checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    // Restrict to card: avoids Stripe requiring a `currency` param to resolve eligibility
    // for other enabled payment method types, and matches what runAutoTopupIfNeeded expects
    // (an off-session card charge) when it later uses the saved payment method.
    payment_method_types: ['card'],
    metadata: { companyId, actorUserId: user.id, kind: 'card_setup' },
    success_url: `${appUrl()}/billing?setup_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing?setup_canceled=1`,
  });
  if (!session.url) throw new GraphQLError('Stripe did not return a checkout URL.');
  return { url: session.url };
}

async function confirmCardSetup(
  _: unknown,
  { sessionId, companyId }: { sessionId: string; companyId: string },
  ctx: GqlContext,
) {
  await requireCompanyOwner(ctx, companyId);
  const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
  if (session.metadata?.companyId === companyId && session.setup_intent && typeof session.setup_intent !== 'string') {
    await persistCardFromSetupIntent(ctx.supabase, companyId, session.setup_intent);
  }
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function updateAutoTopup(
  _: unknown,
  { enabled, thresholdCents, targetCents, companyId }: {
    enabled: boolean;
    thresholdCents?: number | null;
    targetCents?: number | null;
    companyId: string;
  },
  ctx: GqlContext,
) {
  await requireCompanyOwner(ctx, companyId);

  if (enabled) {
    const customer = await getBillingCustomer(ctx.supabase, companyId);
    if (!customer?.stripePaymentMethodId) throw bad('Save a card before enabling auto top-up.');
    if (!Number.isInteger(thresholdCents) || !Number.isInteger(targetCents)) {
      throw bad('Set a minimum balance and a top-up amount.');
    }
    if (thresholdCents! < 0) throw bad('Minimum balance cannot be negative.');
    if (targetCents! < MIN_TOPUP_CENTS || targetCents! > MAX_TOPUP_CENTS) {
      throw bad(`Top-up amount must be between $${MIN_TOPUP_CENTS / 100} and $${MAX_TOPUP_CENTS / 100}.`);
    }
    if (targetCents! <= thresholdCents!) {
      throw bad('Top-up amount must be greater than the minimum balance.');
    }
  }

  await setAutoTopup(ctx.supabase, companyId, {
    enabled,
    thresholdCents: enabled ? thresholdCents! : null,
    targetCents: enabled ? targetCents! : null,
  });
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function removeSavedCard(_: unknown, { companyId }: { companyId: string }, ctx: GqlContext) {
  await requireCompanyOwner(ctx, companyId);
  await removeSavedCardRow(ctx.supabase, companyId);
  return toBillingSettings(await getBillingCustomer(ctx.supabase, companyId));
}

async function finalizeBid(
  _: unknown,
  { takeoffId }: { takeoffId: string },
  ctx: GqlContext,
): Promise<{ data: unknown; balanceCents: number }> {
  const { data: takeoff } = await ctx.supabase
    .from('takeoffs')
    .select('company_id, data')
    .eq('id', takeoffId)
    .maybeSingle();
  if (!takeoff) throw bad('Takeoff not found.');
  await requireCompanyMember(ctx, takeoff.company_id);

  const data = takeoff.data as { bid?: { finalizedAt?: string } };
  if (!data.bid) throw bad('Add pricing before finalizing.');

  // Payment now happens earlier (payForTakeoff, before Materials/Pricing/Bid unlock) — this
  // is a defense-in-depth check, not the primary gate. The client should never let someone
  // reach Finalize without having paid, but never trust the client alone.
  if (!(await isTakeoffPaid(ctx.supabase, takeoffId))) {
    throw new GraphQLError('This bid must be paid for before it can be finalized.', {
      extensions: { code: 'PAYMENT_REQUIRED' },
    });
  }

  data.bid.finalizedAt = new Date().toISOString();
  const { data: saved, error } = await ctx.supabase
    .from('takeoffs')
    .update({ data })
    .eq('id', takeoffId)
    .select('data')
    .single();
  if (error || !saved) throw new GraphQLError('Finalize failed to save.');

  return { data: saved.data, balanceCents: await getBalanceCents(ctx.supabase, takeoff.company_id) };
}

// ── Super-admin dashboard ────────────────────────────────────────────────────

interface RecentTakeoffRow {
  id: string;
  user_id: string;
  created_at: string;
  house_plans: { name: string | null; file_name: string } | null;
  companies: { name: string } | null;
}

async function adminDashboardStats(_: unknown, __: unknown, ctx: GqlContext) {
  await requireSuperAdmin(ctx);

  // auth.users isn't queryable via postgrest, so walk the admin listUsers() pages to get
  // both an exact user count and an id -> email lookup for the recent-takeoffs table.
  const emailsById = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await ctx.supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) emailsById.set(u.id, u.email ?? '');
    if (data.users.length < 200) break;
  }

  const { count: totalTakeoffs, error: takeoffCountErr } = await ctx.supabase
    .from('takeoffs')
    .select('*', { count: 'exact', head: true });
  if (takeoffCountErr) throw takeoffCountErr;

  const { count: totalCompanies, error: companyCountErr } = await ctx.supabase
    .from('companies')
    .select('*', { count: 'exact', head: true });
  if (companyCountErr) throw companyCountErr;

  const { data: creditRows, error: creditErr } = await ctx.supabase
    .from('credit_transactions')
    .select('kind, amount_cents');
  if (creditErr) throw creditErr;
  let totalCreditsToppedUpCents = 0;
  let totalCreditsSpentCents = 0;
  for (const row of (creditRows ?? []) as { kind: string; amount_cents: number }[]) {
    if (row.kind === 'topup') totalCreditsToppedUpCents += row.amount_cents;
    else if (row.kind === 'charge') totalCreditsSpentCents += -row.amount_cents;
  }

  const { data: usageRows, error: usageErr } = await ctx.supabase
    .from('ai_usage')
    .select('input_tokens, output_tokens');
  if (usageErr) throw usageErr;
  const totalAiTokens = (usageRows ?? []).reduce(
    (sum: number, row: { input_tokens: number; output_tokens: number }) =>
      sum + row.input_tokens + row.output_tokens,
    0,
  );

  const { data: recent, error: recentErr } = await ctx.supabase
    .from('takeoffs')
    .select('id, user_id, created_at, house_plans(name, file_name), companies(name)')
    .order('created_at', { ascending: false })
    .limit(10);
  if (recentErr) throw recentErr;

  const recentTakeoffs = ((recent ?? []) as unknown as RecentTakeoffRow[]).map((t) => ({
    id: t.id,
    userEmail: emailsById.get(t.user_id) ?? 'unknown',
    companyName: t.companies?.name ?? null,
    planName: t.house_plans?.name ?? t.house_plans?.file_name ?? null,
    createdAt: t.created_at,
  }));

  return {
    totalUsers: emailsById.size,
    totalTakeoffs: totalTakeoffs ?? 0,
    totalCompanies: totalCompanies ?? 0,
    totalCreditsToppedUpCents,
    totalCreditsSpentCents,
    totalAiTokens,
    recentTakeoffs,
  };
}

export const resolvers = {
  JSON: GraphQLJSON,
  Query: {
    hello: () => 'Hello from Apollo Server!',
    creditBalanceCents,
    bidQuote,
    adminDashboardStats,
    stripeTestMode,
    billingSettings,
    myCompanies,
    companyMembers,
    companyInvites,
    myPendingInvites,
  },
  Mutation: {
    clarifyTakeoff,
    recalculateMaterials,
    getLocalPricing,
    saveSubPrices,
    approveSubBid,
    shareBidPdf,
    createCreditCheckout,
    confirmTopup,
    startCardSetup,
    confirmCardSetup,
    updateAutoTopup,
    removeSavedCard,
    payForTakeoff,
    finalizeBid,
    createSubscriptionCheckout,
    confirmSubscriptionCheckout,
    cancelSubscription,
    resumeSubscription,
    createCompany,
    renameCompany,
    inviteTeamMember,
    revokeInvite,
    acceptInvite,
    removeTeamMember,
  },
};
