import contractorQuestionnaireJson from './contractor-questionnaire.json' with { type: 'json' };
import type { Questionnaire } from './types.js';

export type { Questionnaire, QuestionnaireQuestion, QuestionnaireChoice, QuestionnaireResult } from './types.js';
export const contractorQuestionnaire = contractorQuestionnaireJson as unknown as Questionnaire;
