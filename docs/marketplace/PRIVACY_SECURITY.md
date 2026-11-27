# Privacy and security

## Privacy policy (short form)

Foreman is a Forge app that runs on Atlassian. It processes your Jira and Confluence content only
to provide its features: code review, inspection reports, workflow monitoring and the Rovo agent.

- **No egress:** Foreman sends no data outside Atlassian. There are no analytics, tracking or
  third-party services.
- **Hosted on Atlassian:** compute (Forge functions), storage (Forge SQL and KVS) and AI (Forge
  LLMs) are all provided by Atlassian, in your site's data region where Atlassian supports
  residency.
- **What we store:** see `DATA_HANDLING.md`. In short: work-item keys, plan and evidence text,
  findings, proposals, and an audit log keyed by Atlassian account ID.
- **Who can see it:** only users of your Atlassian site, under Jira project permissions. The
  developer has no access to your data.
- **Deletion:** uninstalling removes Foreman's own storage, following the Forge platform's
  retention rules. Content Foreman created in Jira or Confluence stays yours.
- **Contact:** via GitHub issues on the Foreman repository.

## Security notes

| Area | Control |
|---|---|
| Hosting | Forge, Runs on Atlassian; no `remotes`, no `external` permissions |
| Scopes | 19 scopes, each tied to a feature (listed in `manifest.yml` with comments). Unused graph scopes were removed in v0.8.0 |
| Auth | Forge handles auth, and the app holds no tokens or secrets. User-context calls use `asUser()` |
| Human in the loop | AI output becomes proposals; Jira changes run only after a person approves. Approvals are audited |
| Input validation | Every resolver and Rovo action input is checked with zod. LLM output is schema-validated and retried |
| Errors | Resolvers return plain messages, with no stack traces or internal data. Consent errors go to Forge's "Allow access" flow |
| Rate limits | Jira, Confluence and Teamwork Graph calls retry with backoff. Background jobs use platform retries (`InvocationError`) for 429 and 5xx |
| Custom UI | Strict Forge CSP. Only `unsafe-inline` styles are allowed (design tokens); no remote scripts |
| Audit | Every write records actor, action, target and time in `audit_log`, which you can view under Diagnostics |
| Dependencies | Small server dependency set (`@forge/*`, zod, unpdf). `npm audit` runs before each release |

## Scope justification

| Scope | Used for |
|---|---|
| `read:jira-work`, `write:jira-work` | Read and create work items, comments and links; apply approved proposals |
| `manage:jira-configuration` | Create issue types, link types and Foreman fields during demo setup |
| `manage:jira-project` | Create the demo project and set project properties |
| `read:jira-user` | Show the names of assignees and approvers |
| `storage:app` | Forge SQL and KVS |
| `read/write:space:confluence`, `read/write:page:confluence` | Publish inspection reports to a Foreman space |
| `read:graph:*` (issue, issue-comment, issue-status, project, user, page) | Teamwork Graph context: people, decisions, specs, similar work |
| `read/write/delete:object:jira` | Teamwork Graph connector: city permit portal records |
