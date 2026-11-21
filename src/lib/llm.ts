import { z } from 'zod';
import { withRetry } from './retry';

/**
 * LLM client wrapper.
 *
 * Default provider = Forge LLMs (Atlassian-hosted Claude, text only, Runs-on-Atlassian).
 * Providers are injectable so tests run without Forge, and so an optional BYOK vision
 * provider can be added later without touching callers (see docs/PLAN.md D1).
 */

export const MODELS = {
  /** Fast extraction / classification. */
  fast: 'claude-haiku-4-5-20251001',
  /** Rule evaluation, report drafting. */
  reasoning: 'claude-sonnet-5',
} as const;

/** Models that reject temperature/top_p (Forge LLM validation rules). */
const NO_SAMPLING_PARAMS = new Set(['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  forceTool?: string;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  finishReason: string;
  usage: { input: number; output: number };
}

export interface LlmProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Build the Forge LLM request body, respecting per-model validation rules. */
export function toForgePrompt(req: ChatRequest) {
  const prompt: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => ({ ...m })),
    max_completion_tokens: req.maxTokens ?? 2048,
  };
  if (req.temperature !== undefined && !NO_SAMPLING_PARAMS.has(req.model)) {
    prompt.temperature = req.temperature;
  }
  if (req.tools?.length) {
    prompt.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    prompt.tool_choice = req.forceTool ? { type: 'function', function: { name: req.forceTool } } : 'auto';
  }
  return prompt;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

export const forgeLlmProvider: LlmProvider = {
  async chat(req) {
    // Imported lazily so unit tests never load the Forge runtime.
    const { chat } = await import('@forge/llm');
    const res = await withRetry(
      () => chat(toForgePrompt(req) as unknown as Parameters<typeof chat>[0]),
      {
        retries: 2,
        shouldRetry: (err) => {
          const status = (err as { status?: number }).status;
          return status === 429 || (status !== undefined && status >= 500);
        },
      },
    );
    const choice = res.choices[0];
    return {
      text: contentToText(choice?.message.content),
      toolCalls: (choice?.message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      finishReason: choice?.finish_reason ?? 'unknown',
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    };
  },
};

let activeProvider: LlmProvider = forgeLlmProvider;
export const setLlmProvider = (p: LlmProvider) => {
  activeProvider = p;
};
export const getLlmProvider = () => activeProvider;

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastRaw: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/** Pull a JSON object out of free text (fenced block or first {...}). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('no JSON found');
  return JSON.parse(candidate);
}

export interface StructuredRequest<T extends z.ZodType> {
  schema: T;
  toolName: string;
  toolDescription: string;
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  maxAttempts?: number;
  provider?: LlmProvider;
}

/**
 * Get schema-valid structured output. Forces a single tool call whose parameters are the
 * zod schema as JSON Schema; on parse/validation failure, feeds the error back and retries.
 */
export async function completeStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<{
  data: z.infer<T>;
  attempts: number;
  usage: { input: number; output: number };
}> {
  const provider = req.provider ?? activeProvider;
  const maxAttempts = req.maxAttempts ?? 3;
  const parameters = z.toJSONSchema(req.schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete parameters.$schema;

  const messages: ChatMessage[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  const usage = { input: 0, output: 0 };
  let lastRaw: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await provider.chat({
      model: req.model ?? MODELS.reasoning,
      messages,
      maxTokens: req.maxTokens ?? 4096,
      temperature: 0,
      tools: [{ name: req.toolName, description: req.toolDescription, parameters }],
      forceTool: req.toolName,
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;

    const call = res.toolCalls.find((c) => c.name === req.toolName);
    let raw: unknown;
    try {
      raw = call ? (typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) : extractJson(res.text);
    } catch (e) {
      raw = undefined;
      lastRaw = res.text;
      messages.push(
        { role: 'assistant', content: res.text || '(no tool call)' },
        { role: 'user', content: `Your reply was not valid JSON (${(e as Error).message}). Call ${req.toolName} with valid arguments.` },
      );
      continue;
    }
    lastRaw = raw;
    const parsed = req.schema.safeParse(raw);
    if (parsed.success) return { data: parsed.data, attempts: attempt, usage };

    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    messages.push(
      { role: 'assistant', content: JSON.stringify(raw).slice(0, 4000) },
      { role: 'user', content: `Arguments failed validation: ${issues}. Call ${req.toolName} again with corrected arguments.` },
    );
  }
  throw new StructuredOutputError(`structured output failed after ${maxAttempts} attempts`, maxAttempts, lastRaw);
}
