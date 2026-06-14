// GraphQL schema for the api app. Map-shaped payloads (price maps keyed by
// `${trade}::${description}`, delegation records, takeoff sections) use the JSON
// scalar rather than being modelled field-by-field — they mirror jsonb columns.
export const typeDefs = `#graphql
  scalar JSON

  type Query {
    hello: String
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

    "Estimate local unit prices for line items; returns a bidKey -> unitPrice map."
    getLocalPricing(zipCode: String!, lineItems: [LocalPricingItemInput!]!, takeoffId: ID): JSON!

    "Write a sub's unit prices back into the GC's takeoff delegation data."
    saveSubPrices(takeoffId: ID!, delegations: JSON!): OkResult!

    "Stamp approvedAt on each of the sub's delegated trades."
    approveSubBid(takeoffId: ID!, trades: [String!]!): ApproveResult!

    "Generate the finalized bid PDF and send it via email and/or SMS."
    shareBidPdf(takeoffId: ID!, email: String, phone: String, sharingMode: String): OkResult!
  }
`;
