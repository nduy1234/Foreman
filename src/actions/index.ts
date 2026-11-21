import { z } from 'zod';
import { audit } from '../lib/audit';

/**
 * Rovo action handlers. 55 s limit. Inputs come from the LLM and are untrusted:
 * identity comes from `context.accountId`; issue/project keys prefer `payload.context.jira`.
 */

interface ActionPayload {
  [k: string]: unknown;
  context?: { jira?: { issueKey?: string; projectKey?: string } };
}
interface ActionContext {
  accountId?: string;
}

const projectKeyRe = /^[A-Z][A-Z0-9_]{1,9}$/;

export function resolveProjectKey(payload: ActionPayload): string | null {
  const fromCtx = payload.context?.jira?.projectKey;
  if (fromCtx && projectKeyRe.test(fromCtx)) return fromCtx;
  const fromInput = z.string().optional().safeParse(payload.projectKey);
  const v = fromInput.success ? fromInput.data?.trim().toUpperCase() : undefined;
  return v && projectKeyRe.test(v) ? v : null;
}

/** Stub for P1: proves the agent → action → audit path. Real risk engine lands in Prompt 5. */
export async function getProjectRisks(payload: ActionPayload, context: ActionContext) {
  const projectKey = resolveProjectKey(payload);
  await audit({
    actorAccountId: context?.accountId ?? null,
    actorKind: 'agent',
    action: 'action.getProjectRisks',
    target: projectKey,
  });
  return {
    projectKey,
    status: 'not_ready',
    message:
      'Foreman risk monitoring is installed but no demo project is loaded yet. Open the Foreman Command Center project page and click "Load demo project".',
  };
}
