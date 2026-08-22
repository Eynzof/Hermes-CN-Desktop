export interface AutomationBlueprint {
  id: string;
  name: string;
  steps: string[];
  tags: string[];
  createdAt: number;
}

export interface AutomationSuggestion {
  id: string;
  title: string;
  description: string;
  confidence: number;
  blueprintId?: string;
}
