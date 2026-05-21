/**
 * Model resolver — Step 3
 *
 * Converts a string like "anthropic/claude-sonnet-4-20250514" into a
 * language-model instance that Mastra agents can use.
 *
 * Mastra ships its own provider registry (ModelRouterLanguageModel) which
 * handles all major providers (Anthropic, OpenAI, Google, Mistral, Groq,
 * Fireworks, Together, Ollama, OpenRouter, …) by reading the matching
 * environment variable for the provider's API key.
 *
 * Format: "<provider>/<model-id>"
 *   anthropic/claude-sonnet-4-20250514  → ANTHROPIC_API_KEY
 *   openai/gpt-4o                       → OPENAI_API_KEY
 *   google/gemini-2.5-pro               → GOOGLE_GENERATIVE_AI_API_KEY
 *   ollama/llama3                        → (no key, local server)
 *   openrouter/openai/gpt-4o            → OPENROUTER_API_KEY
 *
 * This function is passed to the Harness as its `resolveModel` callback
 * so every subagent and OM observer/reflector goes through the same resolver.
 */

import { ModelRouterLanguageModel } from '@mastra/core/llm';
import type { MastraLanguageModel } from '@mastra/core/agent';

/**
 * Resolves a model ID string to a Mastra-compatible language model instance.
 *
 * ModelRouterLanguageModel lazy-loads the underlying provider SDK the first
 * time a generation is requested, so this function itself is synchronous and
 * cheap to call.
 *
 * @param modelId - Provider-prefixed model string, e.g. "anthropic/claude-sonnet-4-20250514"
 * @returns A language model instance usable anywhere Mastra expects a model.
 */
export function resolveModel(modelId: string): MastraLanguageModel {
  // ModelRouterLanguageModel accepts any string matching the
  // "<provider>/<model>" pattern in Mastra's provider registry.
  // Unrecognised providers raise at generation time (not here), giving
  // callers a chance to validate the ID before making network calls.
  return new ModelRouterLanguageModel(modelId);
}
