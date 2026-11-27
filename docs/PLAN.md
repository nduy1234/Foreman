# Foreman — build plan (v1, 2026-11-21)

Status: **awaiting approval**. Window: Nov 21 → Dec 22 (deadline 12:00 PT) ≈ 4.5 weeks, solo.

## 1. Architecture

```
                          ┌───────────────────────── Atlassian site (judge's) ─────────────────────────┐
                          │                                                                            │
  Users ──► Jira project ─┤  jira:projectPage  "Foreman Command Center"   (Custom UI, React+Atlaskit)  │
            Issue view  ──┤  jira:issuePanel   "Evidence & Code Review"   (Custom UI)                  │
            Rovo chat   ──┤  rovo:agent "Foreman" ─► rovo:skill x3 ─► action x6 ◄── rovo:mcp (same 6)  │
                          │         │ invoke()                    │                      ▲            │
                          │         ▼                             ▼                      │ ext. MCP    │
                          │  ┌──────────────── Forge functions (nodejs24.x) ───────────┐ │ clients     │
                          │  │ resolvers/ (25s)   actions/ (55s)                        │               │
                          │  │      │  enqueue                                          │               │
                          │  │      ▼                                                   │               │
                          │  │ Queue "jobs" ─► consumers/ (≤900s)                       │               │
                          │  │   planReview · evidenceReport · monitorScan · twgSync    │               │
                          │  │ triggers/: scheduledTrigger(hour, day) · avi:jira:*      │               │
                          │  │                                                          │               │
                          │  │ services/ ── lib/llm (Forge LLM, zod, retry)             │               │
                          │  │          ── lib/jira · lib/confluence (REST, retry)      │               │
                          │  │          ── lib/twg  (requestTeamworkGraph, asUser)      │               │
                          │  │          ── lib/audit                                    │               │
                          │  └───────┬──────────────┬──────────────┬────────────────────┘               │
                          │          ▼              ▼              ▼                                    │
                          │   Forge SQL        Forge KVS     Jira issues/links/fields  Confluence pages │
                          │  proposals,        config,       (system of record for     (published       │
                          │  findings,         monitor       permits, inspections,     inspection       │
                          │  evidence,         rules, demo   RFIs, punch, findings)    reports)         │
                          │  audit, jobs       state                                                    │
                          │                                                                            │
                          │  Teamwork Graph ◄── consume: curated/persisted queries (people, pages,     │
                          │                     comments, related work)                                 │
                          │                 ◄── contribute: graph:connector "City Permit Portal"        │
                          │                     (mock portal records → work items/documents) [R1]       │
                          └────────────────────────────────────────────────────────────────────────────┘
  No external egress by default → Runs on Atlassian eligible.
```

## 2. Key decisions (need your sign-off)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Vision for field photos | **No vision in v1.** Forge LLM is text-only. Photos contribute EXIF (time, GPS, device), filename, inspector caption, and which checklist item the uploader tagged. LLM reasons over notes/transcripts + photo metadata. Pluggable `VisionProvider` interface with BYOK Anthropic behind an off-by-default flag. | Keeps RoA badge, no API key for judges, no conflict with TWG "no egress" policy. Honest "Needs review" when only a photo supports a line. |
| D2 | TWG consume + contribute in one app | **Spike on day 2.** If one manifest with both deploys and works → do both. If not → main app **consumes** (visible Context panel); connector ships as small companion app "Foreman Permit Portal Connector" with its own install link, marked optional. | Docs say an app can't do both. Consumption is what judges can see change agent output. |
| D3 | Where demo data lives | "Load demo project" **creates a dedicated company-managed project `FMD` ("Riverside Commons")** with our issue type scheme, fields, link types. Reset deletes only `foreman-demo`-tagged issues + SQL rows and reseeds. | Avoids mutating the judge's existing projects; fully reproducible. Needs `manage:jira-configuration` + Jira admin (judges are admins). |
| D4 | UI tech | **Custom UI** (React 18 + Atlaskit + design tokens) for both modules, shared component package. | Timeline, heatmap, split view need more than UI Kit. Still RoA-eligible. |
| D5 | Storage | **Forge SQL** for proposals/findings/evidence/audit/jobs; **KVS** for config & monitor rules. | Approval Queue + audit need filtering/sorting/joins. |
| D6 | Primary bonus prize | **Best Agents.** Also eligible for MCP/TWG/Marketplace but only one bonus can be won. | Agent + skills + actions + MCP is the strongest, most demonstrable story. |
| D7 | Models | Haiku 4.5 for extraction/classification; Sonnet 5 for rule evaluation & report drafting; no Opus (latency/cost). | Fits 55 s action limit for quick paths; long jobs go async. |

## 3. Data model

### Jira (system of record)
- **Issue types** (created by seeder via REST): `Permit`, `Inspection`, `RFI`, `Punch Item`,
  `Code Finding`.
- **Custom fields** (Forge `jira:customField` modules, no REST config):
  `Trade` (select: Concrete, Steel, Framing, Electrical, Plumbing, Mechanical, Fire Protection, Finishes),
  `Location / Level` (string), `Permit #` (string), `Jurisdiction` (string),
  `Foreman Risk` (number 0–100). Dates use Jira due date + `Scheduled For` (date field).
- **Link types**: `Blocks` (built-in), `Requires prior inspection` (custom, outward "requires",
  inward "is prerequisite for"), `Governed by permit`.
- **Labels**: `foreman-demo`, `foreman-risk-high|med|low`, `foreman-flag-<rule>`.
- **Statuses** (simple workflow): Permit: Draft → Submitted → In Review → Approved / Expired.
  Inspection: Scheduled → Report Drafted → Awaiting Sign-off → Passed / Failed.
  `Passed` only reachable via Foreman approval of a signed report.

### Forge SQL
```
projects(id, jira_project_key, name, occupancy, construction_type, stories, area_sqft, jurisdiction, created_at)
plan_sets(id, project_id, sheet_id, title, text, source, created_at)
findings(id, project_id, plan_set_id, rule_id, citation, status[pass|fail|needs_review],
         severity, evidence_quote, confidence, suggested_fix, issue_key NULL, state[open|dismissed|approved|ticketed], job_id)
evidence(id, issue_key, kind[photo|note|transcript], attachment_id NULL, text, exif_json, captured_at)
report_lines(id, report_id, checklist_item, observation, status[verified|needs_review|conflict],
             evidence_ids_json, permit_condition, prior_inspection_key, rationale)
reports(id, issue_key, version, confluence_page_id, state[draft|awaiting_signoff|approved|changes_requested], signed_by, signed_at)
proposals(id, project_id, kind[reschedule|notify|escalate|reinspect|create_issue|transition|publish_report|approve_permit],
          target_key, payload_json, why, source[monitor|agent|user], state[pending|approved|rejected|executed|failed],
          created_by, decided_by, decided_at, result_json)
risk_scores(issue_key, project_id, score, reasons_json, computed_at)
audit_log(id, ts, actor_account_id, actor_kind[user|agent|monitor|system], action, target, proposal_id, before_json, after_json)
jobs(id, kind, state[queued|running|done|failed], progress, input_json, result_json, error, created_at, updated_at)
portal_records(id, external_id, permit_no, record_type, status, date, raw_json, ingested_to_twg_at)
```
### KVS
`config:monitor` (thresholds: stuckDays=10, expiryWarnDays=21, rfiAgeDays=7, ackHours=48),
`config:models`, `demo:state` (seed version, created keys), `twg:queryKeys`.

### Rule pack (`src/rules/*.json`, ~36 rules)
```json
{ "id": "EGR-1005.3", "category": "egress", "title": "Egress width per occupant",
  "citation": "IBC 2021 §1005.3.2", "severity": "high",
  "appliesWhen": { "occupancy": ["A","B","M","R-2"], "minStories": 1 },
  "test": "Pass if documented exit width ≥ occupant load × 0.2 in/occupant ...",
  "evidenceHints": ["exit width", "occupant load", "door clear width"] }
```
Categories: egress (10), fire separation (8), accessibility/ADA (8), structural notes (6),
permit prerequisites (4). Citations to IBC 2021 / 2010 ADA Standards section numbers only
(paraphrased tests, no copied code text).

## 4. Modules (manifest)

| Module | Key | Purpose |
|---|---|---|
| `jira:projectPage` | `command-center` | Timeline + critical path, risk heatmap, Approval Queue, onboarding, digest |
| `jira:issuePanel` | `evidence-panel` | Findings, verification breakdown, evidence split view, sign-off |
| `jira:customField` ×5 | trade, level, permit-no, jurisdiction, risk | Construction fields |
| `trigger` | `issue-events` | `avi:jira:created/updated:issue`, `avi:jira:created:issuelink` → incremental monitor |
| `scheduledTrigger` | `monitor-hourly`, `digest-daily` | Full scan, daily digest |
| `consumer` | `jobs-consumer` (queue `jobs`) | Plan review, evidence report, monitor scan, TWG sync |
| `function` | resolver, actions, consumer, triggers | |
| `llm` | `foreman-llm` (`claude`) | Forge LLMs |
| `rovo:agent` | `foreman` | Agent with prompt resource + starters |
| `rovo:skill` ×3 | `plan-code-review`, `inspection-readiness`, `approval-packet` | Reusable playbooks |
| `action` ×6 | `review-plan-against-code` (GET*), `get-project-risks` (GET), `create-inspection-report` (CREATE→proposal), `propose-resolution` (CREATE→proposal), `request-approval` (CREATE→proposal), `approve-pending` (UPDATE, requires explicit user confirmation + permission check) | *review returns cached findings or enqueues and returns job id |
| `rovo:mcp` | `foreman-mcp` | Same 6 actions as MCP tools |
| `graph:connector` | `permit-portal` | Mock city portal → TWG (subject to R1) |
| `sql` | — | Forge SQL + migrations |

Scopes (initial, justify each in manifest): `read:jira-work`, `write:jira-work`,
`manage:jira-configuration` (seed issue types/link types/project), `read:jira-user`,
`storage:app`, `read:page:confluence`, `write:page:confluence`, `read:space:confluence`,
`read:graph:issue:jira`, `read:graph:page:confluence`, `read:graph:user:atlassian`,
`read:graph:comment:jira` (exact names confirmed during Prompt 7), `write/read/delete:object:jira` (connector).
App compatibility: Jira (required) + Confluence (optional) so reports can publish.

## 5. The one demo story — "Riverside Commons"

Mixed-use, 5 stories (1 podium retail M + 4 R-2 residential), Type V-A over I-A, 62,000 sf,
jurisdiction "City of Riverside (demo)". GC: Northbeam Builders. Subs: Atlas Concrete,
Keystone Framing, Volt Electric. Inspectors: J. Ortiz (building), M. Chen (fire).
4 permits: P-1 Foundation, P-2 Building, P-3 MEP, P-4 Fire Sprinkler.
8 inspections: footing → rebar → slab → framing → MEP rough-in → fire → final (+ re-inspect).
Planted problems: (a) Framing inspection scheduled before its prerequisite **Slab** inspection passed;
(b) P-3 MEP permit "In Review" 12 days; (c) Framing field report says "1-hr corridor wall
not yet sheathed" while plan sheet A-201 shows rated assembly complete & Jira says Passed;
(d) RFI-4 aging 9 days; (e) Volt Electric hasn't acknowledged rough-in assignment (60 h);
(f) P-1 expires in 14 days.

Walkthrough (≈3 min of the video):
1. Fresh site → open project page → onboarding checklist → **Load demo project** (≈40 s, progress bar).
2. Command Center lights up: timeline shows critical path through framing; heatmap hot at
   Level 2 / Framing; **Approval Queue** already has 5 monitor proposals, each with a "why".
3. Open Inspection FMD-12 (Framing) → issue panel: **Code Review** tab runs A-201 against egress
   + fire-separation rules → 2 fails with exact quotes + citations → "Create Jira issue" on one.
4. **Evidence** tab: notes + 4 photos → generate report → breakdown 7 Verified / 3 Needs review /
   1 Conflict (corridor wall) shown in split view photo ↔ checklist ↔ plan citation.
5. Inspector clicks **Request changes**; status stays Awaiting Sign-off (never auto-pass). Audit trail shows it.
6. Rovo chat: "What's blocking our framing inspection?" → agent cites slab prerequisite + conflict +
   TWG context ("M. Chen decided the rated-wall detail in page *Fire Assemblies v3*; similar
   delay on FMD-7 took 6 days") → proposes reschedule → appears in Approval Queue → approve → Jira updated, comment posted.
7. "Draft the approval packet for permit P-2" → Confluence page proposal.
8. Context toggle: same proposal with TWG context on vs off — visible difference.

## 6. Schedule (maps to your prompts 1–10)

| Week | Dates | Work |
|---|---|---|
| 1 | Nov 21–27 | P1 scaffold + **R1/R3 spikes** (TWG both-ways, issue-type creation asApp, Forge SQL, LLM tool-calling); P2 data model + seeder |
| 2 | Nov 28–Dec 4 | P3 plan review engine + rule pack + tests; P4 evidence → report → Confluence → sign-off |
| 3 | Dec 5–11 | P5 monitor + proposals + digest; P6 Rovo agent/skills/actions/MCP |
| 4 | Dec 12–18 | P7 TWG consume + connector; P8 UI polish |
| 5 | Dec 19–22 | P9 harden, prod deploy, install link, fresh-site test, Marketplace submit; P10 write-up + video. **Submit by Dec 21.** |

Cut line if behind (in order): BYOK vision flag → connector (keep consume) → daily digest page →
heatmap (keep table) → MCP external-client demo (module stays).

## 7. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | TWG: docs say an app can't both consume API and provide connector | ~~High~~ Resolved / Med | Spike 2026-11-26: both deployed and installed in one app. Runtime confirmation pending on site |
| R2 | TWG API needs org-admin install + granular scopes; empty results silently if scopes missing; asUser only | Med / High | Context panel shows "graph context unavailable" state with reason; core story works without TWG; seed Confluence pages + comments so graph has something real to return |
| R3 | Creating issue types/link types/project asApp may need perms the app lacks or workflow quirks | Med / High | Spike week 1; fallback: use built-in Task + `Foreman Type` custom field |
| R4 | Forge LLM no vision → evidence pipeline weaker | Certain / Med | D1: metadata + notes; honest Needs review; optional BYOK flag |
| R5 | Rovo action 55 s limit vs LLM latency | Med / Med | Actions return cached results or enqueue + return job id; Haiku for fast paths |
| R6 | LLM hallucinated evidence | Med / High | Reject findings whose quote isn't a substring (normalized) of source; temperature 0 where supported; tests on demo plan |
| R7 | Rovo/LLM Preview modules change or agent safety screening blocks deploy | Low / High | Keep prompt factual, no autonomous writes; follow AUP; deploy agent early in week 1 |
| R8 | Judges' site has no Rovo / no Confluence | Med / Med | App works in Jira alone; Confluence optional (report stored in SQL + attachment fallback); test instructions state requirements |
| R9 | Forge SQL / LLM consumption charges | Low / Low | Small demo; Haiku default; cache findings per plan hash |
| R10 | Seeder > 25 s | Certain / Low | Seed runs as async job with progress polling |
| R11 | Local Node v25 vs Forge CLI | Med / Low | Install Node 24 LTS |
| R12 | Only one bonus prize per submission | Certain / Low | Lead with Best Agents in write-up (D6) |
| R13 | Jira + Confluence (multi-app) Forge apps can only be listed on Marketplace as **paid** apps | Certain / Med | Confluence is optional (Jira required); report publishing degrades to Jira-only. Decide before Prompt 9: keep Confluence + paid listing, or drop Confluence for a free listing |
| R14 | Forge LLM is text-only: photo content is not read | Certain / Med | Photos used for EXIF time/GPS and corroboration; VisionProvider hook for opt-in BYOK (costs RoA) |

## 8. Manual steps for you (before Prompt 1)
1. Install Node 24 LTS (nvm-windows) and `npm i -g @forge/cli` (latest 15.x).
2. Create an Atlassian API token → `forge login`.
3. Create a free developer site (Jira + Confluence, Rovo enabled) at
   https://go.atlassian.com/cloud-dev. You must be org admin (needed for TWG scopes).
4. Decide D1–D7 (or accept recommendations).
