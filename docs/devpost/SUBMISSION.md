# Foreman: Devpost submission

**Category:** Apps for Specialized Industries (construction)
**Bonus prizes:** Best Agents (Rovo) · Best app with Atlassian MCP · Best apps with Teamwork Graph integration
(Marketplace: see the note at the end.)
**Install link:** `<paste from Developer Console → Distribution>` · **Video:** `<YouTube URL>` · **Code:** https://github.com/nduy1234/Foreman

---

## Tagline

The AI site superintendent that lives in Jira: it reads the plans, checks the code, verifies the
evidence and watches the schedule. Then it asks a human before it changes anything.

## Inspiration

On a building project, the critical path often runs through the permit office and the city
inspector, not through the crew. These things cost money:
- A framing inspection booked before the slab passes means a failed inspection, a re-inspection
  fee and a crew standing idle.
- A permit sitting "in review" for two weeks pushes back every trade behind it.
- A rebar report that disagrees with the structural sheet can mean concrete gets poured over a
  defect.

Construction teams already track all of this in Jira and Confluence. But the knowledge that
catches these problems (the building code, inspection sequencing, what the plans actually say)
lives in people's heads. Foreman puts that knowledge into the tools the team already uses.

## What it does

Foreman is an AI operating layer for construction projects. It has four connected parts.

1. **Plan-vs-code review.** A plan sheet is checked against 36 machine-readable rules covering
   IBC 2021, ADA, NFPA 13 and ACI 318. Every finding cites the code section and quotes the plan
   text word for word. A finding without a quote is thrown away, never shown. Findings become
   *Code Finding* work items.
2. **Field evidence → verified inspection report.** Photos, notes and checklists are turned into
   a report where every line points to its evidence. Contradictions are flagged instead of
   smoothed over. For example: "Jira says Passed, but the inspector observed #4 bars @ 18 in.
   where S-101 requires #5 @ 12 in." An inspector signs off and the report is published to Confluence.
3. **Workflow monitor.** An hourly scan looks for:
   - inspections booked out of sequence;
   - permits stuck in review or about to expire;
   - unanswered RFIs;
   - unacknowledged assignments;
   - inspections that depend on unapproved permits.

   Each project gets a risk score, a heatmap by trade and level, a critical-path timeline and a
   daily digest.
4. **Human approval, always.** Foreman never edits Jira on its own; it only *proposes*. A person
   approves each proposal in the Approval queue or in Rovo chat, and every change goes in an
   audit log with the approver's name.

All of this is available in three places: Jira (Command Center and issue panel), **Rovo chat**
(the Foreman agent) and **any MCP client** (the same six tools). **Teamwork Graph** fills in the
people, decisions, specs and similar work behind each item, and our connector adds city permit
portal records to the graph.

## How we built it

- **Forge, Runs on Atlassian.** Node 24 functions, Forge SQL (10 migrations), KVS, a Forge Events
  queue for long jobs, and scheduled triggers. The app has no egress at all.
- **Forge LLMs.**
  - Haiku 4.5 for extraction, Sonnet for reasoning.
  - Every response is a forced tool call, validated with zod and retried with the error fed back.
  - The code rules are deterministic JSON, so the LLM only finds candidate issues. A
    verbatim-quote check then removes anything it made up.
- **Custom UI.** React 18, built with Vite, using Atlassian design tokens. Keyboard accessible,
  and every chart has a table view.
- **Rovo.** 1 agent, 6 actions, 3 `SKILL.md` skills and 1 `rovo:mcp` server.
- **Teamwork Graph.**
  - Reads curated queries `asUser`, so results respect each user's permissions.
  - Writes through `graph:connector` + `graph.setObjects`.
- **Quality.** 124 Vitest tests. Retries are automatic: Forge's own retry mechanism
  (`InvocationError`) for rate limits and server errors in background jobs, and backoff on Jira
  and Teamwork Graph calls. Every resolver returns a readable error instead of a stack trace.

## Challenges

- **Jira has no endpoint for "create a construction project".** Seeding the demo means creating
  issue types, link types, six custom fields, screens and schemes in an order Jira accepts. It
  also has to be idempotent and able to resume after a reload.
- **Keeping the LLM honest.** We added deterministic rules, a quote check and schema validation,
  and the AI never writes to Jira directly.
- **Forge's limits.** Resolvers have 25 s and jobs up to 15 min. Every long task runs as a queued
  job that the UI polls for progress.

## What we learned

The graph changes the answer. The same question, "why is framing blocked?", gets a generic
answer from Jira alone. With Teamwork Graph, the answer names who decided to resequence, which
spec page governs the rated corridor walls, and which past inspection failed for the same reason.

## What's next

Real permit-portal connectors for specific cities, photo understanding once Forge LLMs support
images, and a Marketplace listing.

---

## Judging criteria map

| Criterion | Where it shows |
|---|---|
| **Technological implementation** | No hardcoded demo path: the monitor runs real detectors over live Jira data (`src/services/monitor/detect.ts`); code review runs real rules over real sheet text (`src/services/planReview.ts`, `src/rules/*.json`). Supporting pieces: queued long jobs with platform retries (`src/consumers/jobs.ts`, `src/lib/errors.ts`), 10 SQL migrations (`src/lib/db.ts`) and 124 tests (`test/`). Edit any work item and the next scan reflects it. |
| **Design** | One product across Jira, Rovo and MCP. The Command Center (onboarding checklist, risk, heatmap, timeline, approval queue, digest) is in `static/ui/src/shared/CommandCenter.tsx`. The evidence split view is in `EvidenceReport.tsx`. Skeletons and empty and error states throughout; keyboard and screen-reader support; table alternatives for charts. |
| **Potential impact** | Built for general contractors, owner's reps and project managers running permit-heavy work. It targets the delays that cost money: failed inspections, re-inspection fees, idle crews and expired permits. The demo plants 7 such problems, and Foreman finds all of them. |
| **Innovation** | Code citations backed by verbatim quotes, which an LLM can't fake. Evidence-linked reports that flag contradictions. Teamwork Graph used for *why* (decisions, specs), not just *what*. One toolset served as Jira UI, a Rovo agent and an MCP server, with every change approved by a person. |
| **Presentation** | Under-5-minute video telling one end-to-end story (`docs/devpost/VIDEO_SCRIPT.md`). Judges get a 3-step test (`docs/devpost/TESTING.md`). |

## Bonus prize evidence

### Best Agents: Rovo
- `manifest.yml` → `rovo:agent: foreman-agent`: 6 actions, 3 skills, conversation starters and
  a follow-up prompt.
- Agent prompt: `resources/agent/foreman-prompt.txt`.
- Actions (`action:` module, GET/CREATE/UPDATE verbs), in `src/actions/index.ts`, `resolve.ts`
  and `packet.ts`:
  - `review-plan-against-code`
  - `get-project-risks`
  - `create-inspection-report`
  - `propose-resolution`
  - `request-approval`
  - `approve-pending`
- Reusable skills that other agents can use, each declaring its tool dependencies:
  `skills/plan-code-review/SKILL.md`, `skills/inspection-readiness/SKILL.md`,
  `skills/approval-packet/SKILL.md`.
- Human in the loop: `propose-resolution` creates a proposal (`src/services/proposals.ts`), and
  nothing changes until `approve-pending` runs with a person's confirmation.

### Best app with Atlassian MCP
- `manifest.yml` → `rovo:mcp: foreman-mcp` ("Foreman Construction") exposes the same 6 tools to
  any MCP client.
- The open-source `skills/*/SKILL.md` files can be dropped into third-party agents.

### Best apps with Teamwork Graph integration (both directions)
- **Consume:** `src/services/twg/context.ts` (`buildGraphContext`) uses curated queries:
  - `jiraWorkItemComments` for decisions;
  - `atlassianUserContent` for people and their pages;
  - `jiraSpaceWorkItems` for similar work;
  - `objects(ids)`.

  Calls are made `asUser` and retried. `src/services/twg/focus.ts` builds the graph-enriched
  briefing and feeds graph notes into code review and report prompts. The UI is
  `static/ui/src/shared/GraphContext.tsx` (side-by-side "with vs. without graph").
- **Contribute:** `manifest.yml` → `graph:connector: city-permit-portal`.
  `src/services/twg/connector.ts` (`syncPortalToGraph`) writes plan-check events and inspection
  results as `atlassian:work-item` objects associated with the matching Jira issues. Data comes
  from `src/seed/cityPortal.ts`.
- Scopes: `read:graph:*` (6) and `read/write/delete:object:jira`.

### Best Marketplace published app
Not entered for judging. A Marketplace submission requires licensing, which disables the install
link that judges need. Listing copy, privacy, data-handling and screenshot plans are ready in
`docs/marketplace/` for after judging.
