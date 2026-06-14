// Shared TypeScript types and interfaces used across apps
// Add domain models, DTOs, and enums here

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
}
