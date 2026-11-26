# Foreman — project instructions

Foreman is a Forge app for Atlassian Codegeist 2026: an AI operating layer for construction
built on Jira + Confluence + Rovo + Teamwork Graph. It reviews plans against code rules,
tracks permits/inspections as Jira work, turns field evidence into verified inspection
reports, monitors the project for delays/inconsistencies, and routes every write through
human-approved proposals.

- Repo: https://github.com/nduy1234/Foreman
- Build plan: `docs/PLAN.md` (source of truth for scope; update it when scope changes)
- Deadline: **Tue Dec 22, 2026, 12:00 PM PT** (Devpost). Judging Jan 5 – Feb 3, 2027.
- Category: Apps for Specialized Industries. Bonus targets: Best Agents (primary),
  Atlassian MCP, Teamwork Graph, Marketplace. **One submission can win at most one Grand
  Prize + one Bonus Prize.**
- Judges install via a "Start sharing your app" link onto their own site. Zero manual
  setup beyond install + "Load demo project" is the bar. Everything must be real, not a
  hardcoded demo path.

## Platform constraints (verified against developer.atlassian.com, 2026-11-21)

### Runtime & limits
- Runtime: `nodejs24.x` (`app.runtime.name`), arm64. Default memory 512 MB, max 1024 MB.
- Function timeouts:
  - UI resolvers (invoke from frontend): **25 s**
  - Web trigger / Rovo `action` / `rovo:agentConnector`: **55 s**
  - Async event consumers + scheduled triggers: default 55 s, up to **900 s** via
    `timeoutSeconds`
  - Single outbound request inside async consumer: 180 s
- Payloads: invocation 5 MB; frontend `invoke` request 500 KB / response 5 MB;
  Rovo action data ≤ 5 MB.
- Egress: 100 requests per runtime-minute per invocation (excludes requestJira/Confluence).
- Logs: 100 lines per runtime-minute, 200 KB per invocation. Log sparingly.
- Rate limits: 1,200 invocations/min/user; 7,000/min and 300/s per install. Handle 429 with
  `rateLimitReset` (bridge `invoke(..., { rateLimitProperties: true })`).

### Async events (`@forge/events` v2)
- `new Queue<T>({ key })`; `queue.push({ body, delayInSeconds?, concurrency? })`.
  Body **must** be wrapped in `body`. Max 50 events/push, 200 KB combined, delay ≤ 15 min.
- Manifest: `consumer: [{ key, queue, function }]`; consumer function sets
  `timeoutSeconds` (≤ 900). Consumer is a plain exported function, not a Resolver.
- Every LLM job longer than a few seconds goes through a queue. UI polls job status.

### Scheduled triggers
- `scheduledTrigger: [{ key, function, interval: fiveMinute|hour|day|week }]`, max 5 per app.
- No user context (asApp only). Throws are not retried. Duplicate invocations possible →
  handlers must be idempotent.

### Forge LLMs (`@forge/llm`, Preview, Runs-on-Atlassian eligible)
- Manifest: `modules.llm: [{ key, model: [claude] }]`. Adding it = major version upgrade.
- API: `chat({ model, messages, max_completion_tokens, temperature|top_p, tools, tool_choice })`,
  `stream()`, `list()`. Response `choices[0].message.content` + optional `tool_calls`, `usage`.
- **Text only. No image input.** (`ContentPart = TextPart`.) Vision requires BYOK egress.
- Models (Nov 2026): `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`,
  `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-opus-4-6`, `-4-7`, `-4-8`, `claude-opus-5`.
  `claude-opus-4-7/4-8/5` and `claude-sonnet-5` reject `temperature`/`top_p` — omit them.
  `temperature` and `top_p` never together.
- Limits per install: 100 req/min, 500K tokens/min, inference ≤ 5 min (only inside async
  consumer with timeout ≥ 300 s). Context: Haiku 200K/64K, Sonnet & Opus 1M/128K.
- Use tool calling with a single forced tool (`tool_choice: {type:'function',...}`) to get
  structured output, then validate with zod; retry on parse/validation failure.

### Storage
- KVS (`@forge/kvs`): config, rule settings, flags, small docs.
- Custom Entity Store: indexed structured data.
- **Forge SQL**: relational data (proposals, findings, evidence, audit log, jobs).
- Object Store (Preview): binary blobs — not needed; photos stay as Jira attachments.
- Data is per-installation. Never cache tenant data in module-level variables.

### Rovo
- `rovo:agent`: `key, name (≤30 chars), description, icon, prompt (string or
  resource:<key>;<path>), conversationStarters[], actions[], skills[], followUpPrompt`.
- `action`: `key, name, function, actionVerb (GET|CREATE|UPDATE|DELETE|TRIGGER),
  description, inputs{ name: {title,type,required,description} }`. Input types:
  string|integer|number|boolean. Agents run from Automation will NOT call non-GET actions.
  Never trust inputs for authz — read `accountId` from `context`; prefer
  `payload.context.jira.issueKey` over LLM-supplied keys.
- `rovo:skill` (Preview): `key, source.dir` (folder with `SKILL.md`, frontmatter `name`
  must equal dir name, lowercase-hyphen, `description` ≥50 chars), `dependencies.tools[]`
  (action keys). No scripts. Agent lists skills in `skills[]`.
- `rovo:mcp` (Preview): one per app, `key, name (≤30), tools[]` (action keys, ≤50).
  Exposed at `https://mcp.atlassian.com/forge/<appId>` once a site admin enables it.

### Teamwork Graph
- Consume: Teamwork Graph API (Preview, Oct 2026). Use **curated queries** (typed GraphQL
  fields, `first` ≤ 25) or **persisted Cypher** (`customQuery` + `queryKey`, registered via
  TWG Labs Query Builder). Raw `cypherQuery` is unavailable to new apps.
  Call with `api.asUser().requestTeamworkGraph(...)` (backend) or bridge
  `requestTeamworkGraph` (frontend). **asUser only** — not from scheduled triggers.
  Granular scopes `read:graph:<object>:<product>` (e.g. `read:graph:issue:jira`,
  `read:graph:page:confluence`, `read:graph:user:atlassian`). Missing scopes return empty
  results silently. Installing requires an **org admin**. Data read from TWG must never
  be egressed.
- Contribute: `graph:connector` module + `@forge/teamwork-graph` (`graph.setObjects`,
  ≤100 objects/call, needs `connectionId`), scopes `write/read/delete:object:jira`.
  Admin must create a connection in Admin › Apps › Connected apps.
- **Docs state an app can either call the TWG API or provide a connector, not both.**
  Must be verified by spike before relying on both in one app (see PLAN risk R1).

### UI
- `jira:projectPage` (Command Center), `jira:issuePanel` (Evidence & Code Review). Both
  support UI Kit (`render: native`) or Custom UI (`resource`). Project-page subpages only
  work with Custom UI.
- We use **Custom UI** (React + Atlaskit + `@atlaskit/tokens`) for both modules.

### Runs on Atlassian
- Default posture: **no `permissions.external.fetch`** → RoA eligible. Any vision/BYOK egress
  must be an opt-in, separate decision (breaks RoA and conflicts with TWG no-egress policy).

### Jira REST gotchas (verified on the dev site)
- Forge custom fields (`jira:customField`) do NOT appear in `GET /rest/api/3/field`; use the
  paginated `GET /rest/api/3/field/search?type=custom` and match `schema.custom` ending in
  `/static/<moduleKey>`. Field ids on dev: trade 10044, level 10047, permit no 10045,
  jurisdiction 10048, risk 10046, stage 10049 (ids differ per site/env — always look up).
- Forge field values are app-owned: write them with `POST /rest/api/3/app/field/value` **asApp**.
- `POST /rest/api/3/project` rejects `projectTemplateKey` together with explicit schemes:
  create from template, then `PUT /issuetypescheme/project` and `PUT /issuetypescreenscheme/project`.
- JQL search is eventually consistent: issues created seconds ago may be missing. Map keys from
  the bulk-create response and read single issues with `GET /issue/{key}` when it matters.
- `POST /rest/api/3/issueLink`: `inwardIssue` gets the outward description
  (`{inwardIssue: A, outwardIssue: B}` with "Blocks" = "A blocks B").
- Jira admin setup (issue types, schemes, screens, project) only works **asUser** from resolvers;
  consumers/triggers have no user. Resolvers must rethrow `NEEDS_AUTHENTICATION_ERR` so Forge
  can show the "Allow access" consent screen.
- Browser pane: clicks inside Custom UI iframes don't register under an emulated viewport;
  keep the pane at its native size when driving the app.

### Multi-app (Prompt 4)
- `app.compatibility`: Jira required, Confluence optional. Install into Confluence with
  `npx forge install --product confluence ...`. Multi-app apps can only be listed on Marketplace
  as paid apps (PLAN R13). Confluence calls go through `requestConfluence` asUser (v2 pages/spaces).
- Inspection stage changes go through `src/services/issueStage.ts#setStage`; only inspector
  sign-off (`reports.signOff`) may set `Passed`.

### Data model as built (Prompt 2)
- Jira is the system of record: issue types Permit / Inspection / RFI / Punch Item / Code Finding,
  link types Blocks / Requires Prior Inspection / Governed By Permit, Forge fields Trade,
  Location / Level, Permit number, Jurisdiction, Foreman risk score (read-only), Foreman stage
  (read-only). Jira status category mirrors the Foreman stage (company-managed kanban workflow).
- Issue entity property `foreman` (indexed via `jira:entityProperty`, JQL aliases
  `foremanSeed`, `foremanKind`, `foremanStage`, `foremanScheduled`, `foremanSubmitted`,
  `foremanExpires`, `foremanContractor`) holds dates, parties, assignment ack, checklist, sheets.
- Forge SQL: `plan_sets`, `evidence`, `proposals`, `audit_log`, `jobs`. KVS: `demo:FMD` seed
  state, `project:<KEY>:meta` project metadata + parties.
- Demo seed (`src/seed/dataset.ts`, `src/services/demoSeed.ts`): 7 resumable resolver steps,
  dates are offsets from the seed day so planted problems always hold. Reset deletes only
  `foreman-demo` issues in the Foreman-owned project (project property `foreman`).

## Architecture rules
- Every agent/monitor **write** becomes a `Proposal` row (status `pending`) that a human
  approves in the Approval Queue. Approving executes it. Nothing auto-passes an inspection.
- Every user/agent action → `audit_log` row (actor accountId, action, target, before/after,
  proposalId, timestamp). Use `src/lib/audit.ts`; never write audit rows ad hoc.
- LLM findings without a verbatim evidence quote found in the source text are rejected.
- Long work: resolver enqueues job → consumer processes → writes results → UI polls `jobs`.
- Rule packs are JSON in `src/rules/` validated by zod at load and in tests.
- Seeded demo data is tagged (label `foreman-demo` + entity property) so reset only touches
  demo data.

## Coding conventions
- TypeScript strict. No `any` except at SDK boundaries, wrapped immediately in zod parse.
- Layout:
  - `src/index.ts` — exports handlers referenced from `manifest.yml`
  - `src/resolvers/` — UI resolvers (thin; validate input, call services)
  - `src/actions/` — Rovo action handlers (thin)
  - `src/consumers/`, `src/triggers/` — async consumers, scheduled/event triggers
  - `src/services/` — domain logic (planReview, evidence, monitor, proposals, seed, twg)
  - `src/lib/` — schemas (zod), llm client, jira/confluence clients, sql, audit, retry
  - `src/rules/` — JSON rule packs + monitor rule defaults
  - `static/command-center/`, `static/issue-panel/` — Custom UI apps
  - `skills/<name>/SKILL.md` — Rovo skills
  - `test/` — vitest unit tests; fixtures under `test/fixtures/`
- Pure domain functions (rule selection, sequencing checks, risk scoring) take plain data
  and have no Forge imports, so they unit-test without mocks.
- Jira/Confluence calls go through `src/lib/jira.ts` / `confluence.ts` with retry on 429/5xx
  (exponential backoff + jitter, honor `Retry-After`).
- Minimal scopes. Add a scope only with a comment in the manifest saying which feature needs it.
- Tests: `npm test` (vitest). Lint: `forge lint` + `npm run typecheck` before every deploy.
- Commits: small, imperative subject. Don't commit `.env` or Forge variables.

## Local setup notes
- Forge CLI 15 refuses Node 25 (machine default). `node@24` and `@forge/cli` are
  devDependencies, so run the CLI as `npx forge <cmd>` or `npm run forge -- <cmd>` from the
  repo root — npm puts the local Node 24 first on PATH. Never call a global `forge`.
  In PowerShell, plain `npx forge` picks up the system Node 25 and fails — use
  `npm run forge -- <cmd>` there.
- `forge tunnel`: run it in a real terminal tab and stop it with Ctrl+C. Killing the process
  (TaskStop, Stop-Process) skips deregistration, and the site keeps routing Custom UI to
  `localhost:8000` (blank skeleton) until a clean tunnel start/stop. The Claude browser pane
  blocks site→localhost requests (`ERR_BLOCKED_BY_CLIENT`), so tunneled Custom UI can only be
  checked in a normal browser; resolver/back-end changes still need a deploy to show in the pane.
- Dev site: `daysworkspace-43877786.atlassian.net` (Jira; test project `KAN`, test item `KAN-1`).
  App id `53d4112c-bcbe-4a7e-ade7-a44df94a6995`, development env
  `0d4c8705-eb66-4c76-93e8-79a3efc0adb1`. Command Center URL:
  `/jira/software/projects/<KEY>/apps/<appId>/<envId>`.
- CLI usage analytics disabled (`forge settings set usage-analytics false`).
- Custom UI: `static/ui` (Vite + React 18). `npm run build:ui` builds both bundles into
  `static/ui/build/<module>`. Vite config pins an empty PostCSS config because a stray
  `~/postcss.config.js` (tailwind) otherwise breaks the build.
- Secrets (only if BYOK vision is enabled): `forge variables set --encrypt ANTHROPIC_API_KEY`.
