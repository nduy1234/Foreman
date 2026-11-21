import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeStructured, extractJson, LlmProvider, MODELS, StructuredOutputError, toForgePrompt } from '../src/lib/llm';

const Schema = z.object({ ruleId: z.string(), confidence: z.number().min(0).max(1) });

function scripted(replies: Array<{ args?: unknown; text?: string }>): LlmProvider & { calls: number; lastMessages: unknown[] } {
  const p = {
    calls: 0,
    lastMessages: [] as unknown[],
    async chat(req: { messages: unknown[] }) {
      const r = replies[Math.min(p.calls, replies.length - 1)];
      p.calls++;
      p.lastMessages = req.messages;
      return {
        text: r.text ?? '',
        toolCalls: r.args === undefined ? [] : [{ id: 't1', name: 'emit', arguments: r.args }],
        finishReason: 'tool_use',
        usage: { input: 10, output: 5 },
      };
    },
  };
  return p as never;
}

const base = { schema: Schema, toolName: 'emit', toolDescription: 'emit', system: 's', user: 'u' };

describe('toForgePrompt', () => {
  it('omits temperature for models that reject sampling params', () => {
    const p = toForgePrompt({ model: 'claude-sonnet-5', messages: [], temperature: 0 });
    expect(p).not.toHaveProperty('temperature');
  });
  it('keeps temperature for Haiku and forces tool choice', () => {
    const p = toForgePrompt({
      model: MODELS.fast,
      messages: [],
      temperature: 0,
      tools: [{ name: 'emit', description: 'd', parameters: {} }],
      forceTool: 'emit',
    });
    expect(p.temperature).toBe(0);
    expect(p.tool_choice).toEqual({ type: 'function', function: { name: 'emit' } });
  });
});

describe('completeStructured', () => {
  it('returns validated tool-call arguments on first try', async () => {
    const provider = scripted([{ args: { ruleId: 'EGR-1', confidence: 0.9 } }]);
    const r = await completeStructured({ ...base, provider });
    expect(r.data).toEqual({ ruleId: 'EGR-1', confidence: 0.9 });
    expect(r.attempts).toBe(1);
  });

  it('retries with validation feedback, then succeeds', async () => {
    const provider = scripted([{ args: { ruleId: 'EGR-1', confidence: 7 } }, { args: { ruleId: 'EGR-1', confidence: 0.7 } }]);
    const r = await completeStructured({ ...base, provider });
    expect(r.attempts).toBe(2);
    expect(JSON.stringify(provider.lastMessages)).toContain('confidence');
    expect(r.usage).toEqual({ input: 20, output: 10 });
  });

  it('falls back to JSON in text when no tool call is returned', async () => {
    const provider = scripted([{ text: 'Here:\n```json\n{"ruleId":"FIR-2","confidence":0.4}\n```' }]);
    const r = await completeStructured({ ...base, provider });
    expect(r.data.ruleId).toBe('FIR-2');
  });

  it('throws StructuredOutputError after max attempts', async () => {
    const provider = scripted([{ text: 'no json here' }]);
    await expect(completeStructured({ ...base, provider, maxAttempts: 2 })).rejects.toBeInstanceOf(StructuredOutputError);
    expect(provider.calls).toBe(2);
  });
});

describe('extractJson', () => {
  it('parses bare objects inside prose', () => {
    expect(extractJson('ok {"a":1} done')).toEqual({ a: 1 });
  });
});
