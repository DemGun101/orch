import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

export interface LLMConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

interface ResolvedProvider {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
}

function resolveProvider(config?: LLMConfig): ResolvedProvider {
  // 1. Explicit config takes top priority
  if (config?.apiKey && config?.baseURL) {
    return {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model || process.env.LLM_MODEL || 'gemini-2.0-flash',
      provider: 'custom',
    };
  }

  // 2. Explicit env overrides
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
    return {
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL || 'gemini-2.0-flash',
      provider: 'custom',
    };
  }

  // 3. Groq (free tier, generous limits)
  if (process.env.GROQ_API_KEY) {
    return {
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
      model: config?.model || process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
      provider: 'groq',
    };
  }

  // 4. Gemini (default)
  if (process.env.GEMINI_API_KEY) {
    return {
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: config?.model || process.env.LLM_MODEL || 'gemini-2.0-flash',
      provider: 'gemini',
    };
  }

  // 5. No key found — return empty (will fail at call time with a clear error)
  return {
    apiKey: '',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.0-flash',
    provider: 'none',
  };
}

export function createLLMClient(config?: LLMConfig): OpenAI {
  const resolved = resolveProvider(config);
  if (resolved.provider !== 'none' && resolved.provider !== 'custom') {
    console.log(`[LLM] Using provider: ${resolved.provider} (${resolved.model})`);
  }
  return new OpenAI({
    apiKey: config?.apiKey || resolved.apiKey,
    baseURL: config?.baseURL || resolved.baseURL,
  });
}

export function getDefaultModel(config?: LLMConfig): string {
  const resolved = resolveProvider(config);
  return config?.model || resolved.model;
}

// Re-export OpenAI types for convenience
export type { OpenAI };
export type ChatMessage = OpenAI.ChatCompletionMessageParam;
export type ChatResponse = OpenAI.ChatCompletion;
export type ChatTool = OpenAI.ChatCompletionTool;
