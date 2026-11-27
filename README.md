# Foreman

**The AI operating layer for construction, on Jira, Confluence, Rovo and Teamwork Graph.**
Built on Forge for Atlassian Codegeist 2026. Runs on Atlassian: no egress.

Foreman reviews plan sheets against building code, turns field evidence into verified inspection
reports, watches permits and inspections for risk, and proposes fixes that people approve.
It does all of this in Jira, in Rovo chat, or from any MCP client.

## Install

1. Open the install link (from the Developer Console → Distribution) as a site admin, and install on **Jira**. Installing on **Confluence** too is optional and enables report publishing.
2. In Jira, open any project → **Apps → Foreman** → **Allow access**.
3. Select **Load demo project**. In about a minute you get project **FMD, "Riverside Commons"**, with seven planted problems.

## What it does

| Feature | Where | Built on |
|---|---|---|
| Plan-vs-code review with cited, verbatim findings (36 IBC/ADA/NFPA/ACI rules) | Issue panel → Code review, Rovo | Forge LLMs, Forge SQL |
| Field evidence → verified inspection report → sign-off → Confluence | Issue panel → Field evidence & report | Forge LLMs, Confluence REST |
| Workflow monitor: sequencing, stalled or expiring permits, RFIs, acknowledgements | Command Center, hourly and daily triggers | Scheduled triggers, Forge SQL |
| Risk score, heatmap, critical-path timeline, daily digest | Command Center | Custom UI |
| Approval queue: AI proposes, people approve, everything audited | Command Center, Rovo | Jira REST, audit log |
| Rovo agent, 6 actions, 3 skills, MCP server | Rovo chat, MCP clients | `rovo:agent`, `rovo:mcp` |
| Teamwork Graph context (people, decisions, specs, similar work), plus a city permit portal connector | Issue panel → Context, Command Center | Teamwork Graph API, `graph:connector` |

## Develop

```bash
npm install && npm --prefix static/ui install
npm run predeploy          # typecheck + 124 tests + UI build
npx forge deploy           # development
npx forge deploy -e production
npm --prefix static/ui run preview:mock   # UI harness on :5199 with fixtures (npx tsx scripts/ui-fixtures.ts first)
```

Layout: `src/` holds resolvers, actions, consumers, services and rules; `static/ui/` is the React
Custom UI; `skills/` holds the Rovo skills; `test/` holds the Vitest tests; `docs/` has the plan,
QA and Marketplace docs.

## Docs

- [Plan and risks](docs/PLAN.md)
- [Final QA checklist](docs/QA_CHECKLIST.md)
- Marketplace:
  - [listing](docs/marketplace/LISTING.md)
  - [screenshots](docs/marketplace/SCREENSHOTS.md)
  - [privacy & security](docs/marketplace/PRIVACY_SECURITY.md)
  - [data handling](docs/marketplace/DATA_HANDLING.md)
  - [Developer Console steps](docs/marketplace/DEVELOPER_CONSOLE_STEPS.md)
- Devpost:
  - [submission](docs/devpost/SUBMISSION.md)
  - [judge testing](docs/devpost/TESTING.md)
  - [video script](docs/devpost/VIDEO_SCRIPT.md)
