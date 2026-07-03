// GraphQL schema for the api app. Map-shaped payloads (price maps keyed by
// `${trade}::${description}`, delegation records, takeoff sections) use the JSON
// scalar rather than being modelled field-by-field — they mirror jsonb columns.
export const typeDefs = `#graphql
  scalar JSON

  type Query {
    hello: String

    "Current prepaid credit balance for the signed-in user, in cents."
    creditBalanceCents: Int!

    "Tier, price, and whether a takeoff's bid is already paid for — drives the finalize UI."
    bidQuote(takeoffId: ID!): BidQuote!
  }

  type BidQuote {
    "simple | standard | complex"
    tier: String!
    priceCents: Int!
    "True if this bid was already charged (re-finalizing won't charge again)."
    alreadyPaid: Boolean!
    balanceCents: Int!
  }

  type CheckoutSession {
    url: String!
  }

  type CreditResult {
    balanceCents: Int!
  }

  type FinalizeResult {
    "Updated takeoff data (with bid.finalizedAt stamped)."
    data: JSON!
    balanceCents: Int!
  }

  input ClarificationInput {
    gap: String!
    clarification: String!
  }

  type ClarifyResult {
    "Array of TakeoffSection objects that changed."
    updatedSections: JSON!
    resolvedGaps: [String!]!
  }

  input LocalPricingItemInput {
    trade: String!
    description: String!
    unit: String!
  }

  type LocalPricingResult {
    "bidKey -> { material, labor } unit-cost map."
    prices: JSON!
    "Total tokens consumed by the pricing request (input + output + cache)."
    totalTokens: Int!
  }

  type ApproveResult {
    ok: Boolean!
    approvedAt: String!
  }

  type OkResult {
    ok: Boolean!
  }

  type Mutation {
    "Recompute takeoff line items from a batch of gap clarifications."
    clarifyTakeoff(takeoffId: ID!, clarifications: [ClarificationInput!]!): ClarifyResult!

    "Estimate local unit prices for line items; returns the price map plus token usage."
    getLocalPricing(zipCode: String!, lineItems: [LocalPricingItemInput!]!, takeoffId: ID): LocalPricingResult!

    "Write a sub's unit prices back into the GC's takeoff delegation data."
    saveSubPrices(takeoffId: ID!, delegations: JSON!): OkResult!

    "Stamp approvedAt on each of the sub's delegated trades."
    approveSubBid(takeoffId: ID!, trades: [String!]!): ApproveResult!

    "Generate the finalized bid PDF and send it via email and/or SMS."
    shareBidPdf(takeoffId: ID!, email: String, phone: String, sharingMode: String): OkResult!

    "Create a Stripe Checkout session to buy the given amount of credits (cents)."
    createCreditCheckout(amountCents: Int!): CheckoutSession!

    "Confirm a returned Checkout session and credit the balance (idempotent)."
    confirmTopup(sessionId: String!): CreditResult!

    "Charge the bid's tier price against credits (once per bid) and finalize it."
    finalizeBid(takeoffId: ID!): FinalizeResult!
  }
`;
