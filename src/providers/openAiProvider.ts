import { LLMProvider, AnalysisRequest, AnalysisResult } from "./llmProvider.js";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export class OpenAiProvider implements LLMProvider {
  name = "OpenAI-compatible";
  private apiKey: string;
  private baseURL: string;
  private model: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.apiKey = config.apiKey || process.env.AGENTDOCTOR_API_KEY || process.env.OPENAI_API_KEY || "";
    this.baseURL = config.baseURL || process.env.AGENTDOCTOR_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.model = config.model || process.env.AGENTDOCTOR_MODEL || "gpt-4o-mini";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    if (!this.isConfigured()) {
      return {
        suggestions: ["LLM API key not configured. Static rule analysis used."],
      };
    }

    try {
      const prompt = `You are AgentDoctor AI diagnostics module. Analyze the following context instructions:
Task: ${request.task}
Instructions:
${request.instructions}

Respond with JSON format:
{
  "score": number, // 0-100 quality score
  "suggestions": string[],
  "redundantSnippets": string[]
}`;

      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.1,
        }),
      });

      if (!res.ok) {
        throw new Error(`LLM API request failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as any;
      const content = json.choices?.[0]?.message?.content;
      if (content) {
        return JSON.parse(content);
      }
      return { suggestions: [] };
    } catch (err: any) {
      return {
        suggestions: [`AI analysis error: ${err.message || String(err)}`],
      };
    }
  }
}
