# Data handling summary

Foreman runs entirely on Atlassian infrastructure (Forge, **Runs on Atlassian**). It declares no
`remotes` and no `external.fetch`: **no data leaves Atlassian**.

## Where data lives

| Store | What | Personal data |
|---|---|---|
| **Jira** (customer-owned) | The demo project, work items, Foreman custom fields, issue links, comments, the `foreman` entity property, and project properties | Assignees/reporters as normal Jira users |
| **Confluence** (customer-owned, optional) | Published inspection reports | Inspector name in the sign-off block |
| **Forge SQL**: `audit_log` | Who did what and when, for every write and approval | Atlassian account ID |
| **Forge SQL**: `jobs` | Background job state and progress messages | Account ID of the requester |
| **Forge SQL**: `proposals` | Proposed Jira changes and their approve/reject state | Account IDs of proposer and approver |
| **Forge SQL**: `plan_sets`, `findings` | Plan sheet text and code-review findings | None |
| **Forge SQL**: `evidence`, `inspection_reports` | Evidence metadata, report lines and sign-off | Inspector account ID |
| **Forge SQL**: `monitor_problems`, `risk_scores`, `digests` | Monitor results | None (work-item keys only) |
| **Forge KVS** | Site cloud ID, Confluence space ID, per-project metadata, monitor config and last run, onboarding state, cached demo graph context | None |
| **Teamwork Graph** (connector) | City permit portal records written as `atlassian:work-item` objects | None |

## AI processing

- Forge LLMs (Atlassian-hosted Claude models) process plan sheet text, evidence notes and
  context. Prompts and responses stay within Atlassian, and Foreman doesn't keep raw prompts.
- No customer data is used to train models (Forge LLM terms).

## Access model

- **asApp**: seeding, monitor scans, scheduled triggers and approved changes. Every one is
  written to the audit log with the human who approved it.
- **asUser**: Teamwork Graph reads and reads made on behalf of the current user, so results
  respect that user's own permissions.
- AI output is never applied directly. It becomes a proposal that a person approves.

## Retention and deletion

- Foreman's SQL and KVS data stays for the life of the installation.
- On uninstall, the Forge platform deletes app storage under Atlassian's Forge data retention
  policy.
- Jira and Confluence content created by Foreman belongs to the customer and stays after
  uninstall.
- To remove the demo, delete project `FMD` and the "Foreman Inspection Reports" Confluence space (`FRMN`).

## Personal data (GDPR)

- Foreman stores only Atlassian **account IDs**: no emails or names in its own tables. Display
  names are looked up live.
- Account IDs in the audit log, proposals and sign-offs are needed to attribute approvals.
- **Before a public Marketplace listing:** add Personal Data Reporting (a scheduled check of
  stored account IDs that anonymises closed accounts). It isn't needed for the hackathon install
  link.
