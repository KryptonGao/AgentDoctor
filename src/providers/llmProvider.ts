export interface AnalysisRequest {
  instructions: string;
  task: "semantic-duplicate" | "instruction-quality" | "semantic-conflict" | "compress-context";
}

export interface AnalysisResult {
  score?: number;
  suggestions: string[];
  redundantSnippets?: string[];
}

export interface LLMProvider {
  name: string;
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;
}
