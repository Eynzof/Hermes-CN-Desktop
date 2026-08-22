export interface ModelsDevProviderInfo {
  id: string;
  name: string;
  env: string[];
  api: string;
  doc: string;
  modelCount: number;
}

export interface ModelsDevModelInfo {
  id: string;
  name: string;
  family: string;
  providerId: string;
  reasoning: boolean;
  toolCall: boolean;
  supportsVision: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  contextWindow: number;
  maxOutput: number;
  costInput: number;
  costOutput: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  status: string;
  knowledgeCutoff: string;
}

export interface ModelsDevRegistry {
  schemaVersion: number;
  generatedAt: string;
  providers: ModelsDevProviderInfo[];
  models: ModelsDevModelInfo[];
}

export interface ModelCapabilities {
  reasoning: boolean;
  toolCall: boolean;
  supportsVision: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  contextWindow: number;
  maxOutput: number;
}
