import { contractorQuestionnaire } from './questionnaire/index.js';

export interface Trade {
  /** Stable slug — the questionnaire choice value, also stored in `user_settings.trades`. */
  value: string;
  /** Human-readable display name — shown in the UI and stored as the subcontractor trade tag. */
  label: string;
}

/**
 * Single source of truth for the app's trades. Derived from the `contractor-type`
 * question's choices so the questionnaire (takeoff scoping), the settings trade
 * selector, and the subcontractor trade tags can never drift apart — add or rename
 * a trade once, in `contractor-questionnaire.json`, and every consumer follows.
 */
export const TRADES: Trade[] = contractorQuestionnaire.questions['contractor-type'].choices.map(
  ({ value, label }) => ({ value, label }),
);
