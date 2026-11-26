import { jira, mapLimit, route } from '../lib/jira';
import { stageCategory, Stage } from '../seed/dataset';
import { getForemanFieldIds } from './jiraConfig';

/**
 * Change a work item's Foreman stage everywhere it is shown: the `foreman` entity property
 * (source of truth for Foreman logic), the read-only "Foreman stage" field (asApp), and the
 * Jira status category via a workflow transition. Only call this from an explicit human
 * decision (sign-off) or an approved proposal.
 */
export async function setStage(issueKey: string, stage: Stage, extra: Record<string, unknown> = {}): Promise<void> {
  const prop = await jira<{ value: Record<string, unknown> } | null>(route`/rest/api/3/issue/${issueKey}/properties/foreman`, {
    as: 'user',
    allow: [404],
  });
  await jira(route`/rest/api/3/issue/${issueKey}/properties/foreman`, {
    as: 'user',
    method: 'PUT',
    body: { ...(prop?.value ?? {}), ...extra, stage },
  });

  const fieldIds = await getForemanFieldIds('app');
  if (fieldIds.stage) {
    const issue = await jira<{ id: string; fields: { status: { statusCategory: { key: string } } } }>(route`/rest/api/3/issue/${issueKey}?fields=status`, {
      as: 'user',
    });
    await jira(route`/rest/api/3/app/field/value`, {
      as: 'app',
      method: 'POST',
      body: { updates: [{ customField: fieldIds.stage, issueIds: [Number(issue.id)], value: stage }] },
    });
    const want = stageCategory(stage);
    if (issue.fields.status.statusCategory.key !== want) {
      const { transitions } = await jira<{ transitions: { id: string; to: { name: string; statusCategory: { key: string } } }[] }>(
        route`/rest/api/3/issue/${issueKey}/transitions`,
        { as: 'user' },
      );
      const options = transitions.filter((t) => t.to.statusCategory.key === want);
      const pick = options.find((t) => /progress/i.test(t.to.name)) ?? options[0];
      if (pick) await jira(route`/rest/api/3/issue/${issueKey}/transitions`, { as: 'user', method: 'POST', body: { transition: { id: pick.id } } });
    }
  }
}

export { mapLimit };
