// GraphQL schema for the api app. Map-shaped payloads (price maps keyed by
// `${trade}::${description}`, delegation records, takeoff sections) use the JSON
// scalar rather than being modelled field-by-field — they mirror jsonb columns.
export const typeDefs = `#graphql
  scalar JSON

  type Query {
    hello: String

    "Current prepaid credit balance for the given company, in cents. Caller must be a member."
    creditBalanceCents(companyId: ID!): Int!

    "Square footage, price, and whether a takeoff's bid is already paid for — drives the Materials/Pricing/Bid payment gate."
    bidQuote(takeoffId: ID!): BidQuote!

    "Aggregate usage/revenue stats for the super-admin dashboard. SuperAdmin role required."
    adminDashboardStats: AdminDashboardStats!

    "True if the server's Stripe key is a test-mode key (sk_test_...)."
    stripeTestMode: Boolean!

    "Saved-card and auto top-up configuration for the given company. Caller must be a member; balance/plan are visible to all, only owners can change them."
    billingSettings(companyId: ID!): BillingSettings!

    "Companies the signed-in user belongs to, with their role in each."
    myCompanies: [CompanyMembership!]!

    "Members of a company. Caller must be a member."
    companyMembers(companyId: ID!): [CompanyMember!]!

    "Invites (any status) for a company, newest first. Caller must be a member."
    companyInvites(companyId: ID!): [CompanyInvite!]!

    "Pending, unexpired invites addressed to the signed-in user's own email."
    myPendingInvites: [CompanyInvite!]!
  }

  type Company {
    id: ID!
    name: String!
    billingEmail: String
    createdAt: String!
  }

  type CompanyMembership {
    company: Company!
    role: String!
  }

  type CompanyMember {
    userId: ID!
    email: String!
    role: String!
    joinedAt: String!
  }

  type CompanyInvite {
    id: ID!
    companyId: ID!
    email: String!
    role: String!
    status: String!
    createdAt: String!
    expiresAt: String!
    "Accept token. Only ever populated on myPendingInvites (already scoped to the caller's own verified email) — null on companyInvites' owner-facing roster."
    token: ID
  }

  type BillingSettings {
    hasSavedCard: Boolean!
    cardBrand: String
    cardLast4: String
    autoTopupEnabled: Boolean!
    "Balance (cents) that triggers an automatic top-up."
    autoTopupThresholdCents: Int
    "Balance (cents) an automatic top-up brings the account back up to."
    autoTopupTargetCents: Int
    "Set when the last automatic charge failed; cleared once the card or settings are updated."
    autoTopupDisabledReason: String
    "'per_bid' (default, metered) or 'monthly' (flat-rate unlimited bids)."
    plan: String!
    "Mirrors Stripe's subscription status (active, trialing, past_due, canceled, ...); null if never subscribed."
    subscriptionStatus: String
    "True once cancelSubscription has been called — plan reverts to per_bid at period end."
    subscriptionCancelAtPeriodEnd: Boolean!
    "When the current monthly billing period ends (ISO string); null if never subscribed."
    subscriptionCurrentPeriodEnd: String
    "Flat monthly price, in cents, for the unlimited-bids plan."
    monthlyPlanPriceCents: Int!
  }

  type AdminDashboardStats {
    totalUsers: Int!
    totalTakeoffs: Int!
    totalCompanies: Int!
    "Sum of all Stripe credit top-ups, in cents."
    totalCreditsToppedUpCents: Int!
    "Sum of all per-bid credit charges, in cents."
    totalCreditsSpentCents: Int!
    "Sum of input + output tokens across all ai_usage rows."
    totalAiTokens: Int!
    "Most recently created takeoffs, newest first."
    recentTakeoffs: [RecentTakeoff!]!
  }

  type RecentTakeoff {
    id: ID!
    userEmail: String!
    companyName: String
    planName: String
    createdAt: String!
  }

  type BidQuote {
    "Total square footage across the takeoff's areas. 0 if the bid is already paid (no new charge is being computed)."
    squareFeet: Int!
    "Price in cents: max($15, squareFeet * 5 cents). 0 if the bid is already paid."
    priceCents: Int!
    "True if this bid was already charged — Materials/Pricing/Bid are unlocked."
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

  input ClarificationFileInput {
    "Original file name (used for display and to infer the media type when needed)."
    name: String!
    "MIME type, e.g. application/pdf or image/png."
    mediaType: String!
    "Base64-encoded file contents (no data: prefix)."
    data: String!
  }

  input ClarificationInput {
    gap: String!
    clarification: String!
    "Optional supporting file (spec sheet, photo, PDF) for the model to read."
    file: ClarificationFileInput
  }

  type ClarifyResult {
    "Array of TakeoffSection objects that changed."
    updatedSections: JSON!
    resolvedGaps: [String!]!
  }

  type RecalculateMaterialsResult {
    "Array of TakeoffSection objects that changed."
    updatedSections: JSON!
    "Number of line items with a user-added assumption that were considered."
    consideredCount: Int!
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

  type PayResult {
    balanceCents: Int!
  }

  type Mutation {
    "Recompute takeoff line items from a batch of gap clarifications."
    clarifyTakeoff(takeoffId: ID!, clarifications: [ClarificationInput!]!): ClarifyResult!

    "Recompute quantities for every line item that has a user-added assumption note."
    recalculateMaterials(takeoffId: ID!): RecalculateMaterialsResult!

    "Estimate local unit prices for line items; returns the price map plus token usage."
    getLocalPricing(zipCode: String!, lineItems: [LocalPricingItemInput!]!, takeoffId: ID): LocalPricingResult!

    "Write a sub's unit prices back into the GC's takeoff delegation data."
    saveSubPrices(takeoffId: ID!, delegations: JSON!): OkResult!

    "Stamp approvedAt on each of the sub's delegated trades."
    approveSubBid(takeoffId: ID!, trades: [String!]!): ApproveResult!

    "Generate the finalized bid PDF and send it via email and/or SMS."
    shareBidPdf(takeoffId: ID!, email: String, phone: String, sharingMode: String): OkResult!

    "Create a Stripe Checkout session to buy the given amount of credits (cents). Owner-only."
    createCreditCheckout(amountCents: Int!, companyId: ID!): CheckoutSession!

    "Confirm a returned Checkout session and credit the balance (idempotent). Owner-only."
    confirmTopup(sessionId: String!, companyId: ID!): CreditResult!

    "Starts a Stripe Checkout session (setup mode) to save a card for auto top-up. Owner-only."
    startCardSetup(companyId: ID!): CheckoutSession!

    "Confirms a returned card-setup session and saves the payment method (idempotent). Owner-only."
    confirmCardSetup(sessionId: String!, companyId: ID!): BillingSettings!

    "Enables/disables auto top-up. When enabling, thresholdCents/targetCents are required and a card must already be saved. Owner-only."
    updateAutoTopup(enabled: Boolean!, thresholdCents: Int, targetCents: Int, companyId: ID!): BillingSettings!

    "Removes the saved card and turns off auto top-up. Owner-only."
    removeSavedCard(companyId: ID!): BillingSettings!

    "Charges the prepaid credit balance for this takeoff's square footage (once per takeoff) and unlocks Materials, Pricing, and Bid."
    payForTakeoff(takeoffId: ID!): PayResult!

    "Stamp a paid bid as finalized (locked) — no charge; payment already happened via payForTakeoff."
    finalizeBid(takeoffId: ID!): FinalizeResult!

    "Creates a Stripe Checkout session (subscription mode) for the monthly unlimited-bids plan. Owner-only."
    createSubscriptionCheckout(companyId: ID!): CheckoutSession!

    "Confirms a returned subscription Checkout session and syncs the plan (idempotent). Owner-only."
    confirmSubscriptionCheckout(sessionId: String!, companyId: ID!): BillingSettings!

    "Cancels the monthly plan at the end of the current billing period. Owner-only."
    cancelSubscription(companyId: ID!): BillingSettings!

    "Undoes a pending cancellation, keeping the monthly plan active. Owner-only."
    resumeSubscription(companyId: ID!): BillingSettings!

    "Creates a new company with the caller as its owner."
    createCompany(name: String!): Company!

    "Renames a company. Any member may call this — shared business info, no money/membership angle."
    renameCompany(companyId: ID!, name: String!): Company!

    "Invites a teammate by email. Owner-only."
    inviteTeamMember(companyId: ID!, email: String!): CompanyInvite!

    "Revokes a pending invite. Owner-only."
    revokeInvite(inviteId: ID!): OkResult!

    "Accepts a pending invite addressed to the signed-in user's own email, joining that company."
    acceptInvite(token: ID!): Company!

    "Removes a team member from a company. Owner-only; blocked if it would remove the last owner."
    removeTeamMember(companyId: ID!, userId: ID!): OkResult!
  }
`;
