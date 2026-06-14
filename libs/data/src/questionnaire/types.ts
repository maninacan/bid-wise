export interface QuestionnaireChoice {
  label: string;
  value: string;
  next: string;
  specialAction?: { type: 'select-all'; except?: string[] };
}

export interface QuestionnaireQuestion {
  id: string;
  text: string;
  hint?: string;
  select: 'one' | 'multiple';
  choices: QuestionnaireChoice[];
  passthrough?: string;
}

export interface QuestionnaireResult {
  id: string;
  bidProfile: string;
  pricingModel: 'lump-sum' | 'unit-price' | 'time-materials' | 'cost-plus' | 'square-foot';
  description: string;
  typicalLineItems: string[];
  permitLikelihood: 'required' | 'common' | 'rare';
  tags: string[];
}

export interface Questionnaire {
  start: string;
  questions: Record<string, QuestionnaireQuestion>;
  results: Record<string, QuestionnaireResult>;
}
