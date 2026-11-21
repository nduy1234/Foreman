import { describe, expect, it, vi } from 'vitest';
import { HttpError, withRetry } from '../src/lib/retry';
import { clipJson } from '../src/lib/audit';
import { resolveProjectKey } from '../src/actions';
import { AuditEntry, JobEventBody, Rule } from '../src/lib/schemas';

vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

const noSleep = { sleep: async () => undefined };

describe('withRetry', () => {
  it('retries 429 then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      if (n++ < 2) throw new HttpError('rate limited', 429);
      return 'ok';
    }, noSleep);
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry 400', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new HttpError('bad', 400);
      }, noSleep),
    ).rejects.toThrow('bad');
    expect(n).toBe(1);
  });

  it('honors retryAfterMs', async () => {
    const waits: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (n++ === 0) throw new HttpError('slow down', 429, undefined, 1234);
        return 1;
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([1234]);
  });
});

describe('audit helpers', () => {
  it('clips oversized JSON', () => {
    const s = clipJson({ big: 'x'.repeat(20000) }, 100)!;
    expect(JSON.parse(s).truncated).toBe(true);
  });
  it('validates audit entries', () => {
    expect(() => AuditEntry.parse({ actorAccountId: null, actorKind: 'robot', action: 'x', target: null })).toThrow();
    expect(AuditEntry.parse({ actorAccountId: 'a', actorKind: 'user', action: 'x', target: 'FMD-1' }).proposalId).toBeNull();
  });
});

describe('action input hardening', () => {
  it('prefers Atlassian context over LLM input', () => {
    expect(resolveProjectKey({ projectKey: 'EVIL', context: { jira: { projectKey: 'FMD' } } })).toBe('FMD');
  });
  it('normalizes and validates LLM-supplied keys', () => {
    expect(resolveProjectKey({ projectKey: ' fmd ' })).toBe('FMD');
    expect(resolveProjectKey({ projectKey: "FMD'; DROP" })).toBeNull();
  });
});

describe('schemas', () => {
  it('rejects malformed job events', () => {
    expect(() => JobEventBody.parse({ jobId: 'x', kind: 'ping' })).toThrow();
  });
  it('parses a rule with defaults', () => {
    const r = Rule.parse({
      id: 'EGR-1005.3',
      category: 'egress',
      title: 't',
      citation: 'IBC 2021 §1005.3.2',
      severity: 'high',
      test: 'Pass if documented exit width meets occupant load.',
    });
    expect(r.appliesWhen).toEqual({});
    expect(r.evidenceHints).toEqual([]);
  });
});
