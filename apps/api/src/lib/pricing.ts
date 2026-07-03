// Per-bid usage pricing. A finalized bid is classified into a complexity tier by the
// AI tokens its takeoff consumed (from the takeoff_token_usage view), and the tier's flat
// price is deducted from the user's prepaid credit balance.
//
// Thresholds are deliberately simple constants — revisit once real bids accumulate
// (Opus 4.8 + adaptive thinking pushes token counts up vs. the original estimates).

export type BidTier = 'simple' | 'standard' | 'complex';

/** Upper token bounds (inclusive-exclusive) for the cheaper tiers; above the last → complex. */
const TIER_TOKEN_THRESHOLDS: { tier: BidTier; maxTokens: number }[] = [
  { tier: 'simple', maxTokens: 80_000 },
  { tier: 'standard', maxTokens: 130_000 },
];

/** Flat price per finalized bid, in cents. */
export const TIER_PRICE_CENTS: Record<BidTier, number> = {
  simple: 1500, // $15
  standard: 2500, // $25
  complex: 4500, // $45
};

/** Classifies a takeoff into a tier from its total AI tokens (input + output). */
export function tierFor(totalTokens: number): BidTier {
  for (const { tier, maxTokens } of TIER_TOKEN_THRESHOLDS) {
    if (totalTokens < maxTokens) return tier;
  }
  return 'complex';
}

export function priceCentsFor(totalTokens: number): number {
  return TIER_PRICE_CENTS[tierFor(totalTokens)];
}
