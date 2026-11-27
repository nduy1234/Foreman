# Final QA checklist

Tick every box on a **fresh site** installed from the production install link
(`docs/marketplace/DEVELOPER_CONSOLE_STEPS.md` §3), and not on the dev site.

## A. Build gates (local, before every production deploy)

- [ ] `npm run typecheck` is clean (`npm run predeploy` runs typecheck, tests and the UI build together).
- [ ] `npm test`: all 124 tests pass.
- [ ] `npm run lint` shows no errors.
- [ ] `npm --prefix static/ui run build` builds both bundles.
- [ ] `npx forge deploy -e production` succeeds and the Developer Console shows **Runs on Atlassian**.
- [ ] `manifest.yml` has no `remotes`, no `external.fetch` and no `licensing` block.
- [ ] `src/version.ts` is bumped, and Diagnostics shows the same version.

## B. Judge's path (fresh site, zero manual setup)

### Install

- [ ] Opening the install link shows Foreman with its permission list. Install it on Jira.
- [ ] Install on Confluence as well, from the same link.
- [ ] The lifecycle trigger runs: SQL migrations apply on first use, and Diagnostics → Health check is all green.

### Command Center (Jira → any project → Apps → Foreman)

- [ ] The first open asks for **Allow access** once, and the screen then loads with no error.
- [ ] The onboarding checklist appears. Select **Load demo project**; the progress steps finish.
- [ ] Project **FMD "Riverside Commons"** exists, with inspections, permits, RFIs, punch items and code findings.
- [ ] Foreman fields (trade, level, permit no., jurisdiction, risk, stage) show on work items.
- [ ] Reloading the page mid-seed offers **Resume loading demo project**, which finishes the seed without duplicates.

### Monitor

- [ ] **Run monitor now** finds the planted problems A–G:
  - A: framing inspection before the slab inspection passes
  - B: permit stuck in review
  - C: rebar report contradicts S-101
  - D: RFI unanswered
  - E: assignment not acknowledged
  - F: permit expiring
  - G: inspection waiting on an unapproved permit
- [ ] The project risk score is above 0, and the heatmap highlights Level 2 / MEP.
- [ ] The timeline shows the critical path, and its **Show as table** view is readable.
- [ ] The approval queue holds proposals with their source attribution. Approve one: the Jira change applies and the audit log records it.
- [ ] Rejecting a proposal changes nothing in Jira.
- [ ] The daily digest: **Scan and refresh digest** produces a digest.

### Code review (issue panel on a work item tied to sheet A-201)

- [ ] **Code review**: choose A-201 and run it. The findings cite IBC sections and quote the plan text verbatim, including the 55 ft dead-end corridor.
- [ ] Every finding links to its sheet and rule, and "Hide rules" toggles the rule list.

### Field evidence and report (issue panel on I2, the rebar inspection)

- [ ] **Generate verified report** produces checklist lines with a verdict, and each line links to its evidence.
- [ ] The split view: selecting a report line highlights the matching photo or note.
- [ ] The contradiction with S-101 is flagged, so the report doesn't claim the inspection passed.
- [ ] Sign-off records the inspector's account ID and time.
- [ ] Publish to Confluence creates a page in the demo space. If Confluence isn't installed, a clear "Confluence unavailable" message shows instead.

### Teamwork Graph

- [ ] **Context** tab: people involved, who decided what, relevant pages and similar work all fill in.
- [ ] **Add demo decisions and spec pages**, then reload: the graph-enriched briefing differs from the plain one.
- [ ] Optional: an admin connects the City permit portal. **Sync portal records now** then reports objects written, and the records appear on the linked work items.

### Rovo (Rovo chat → Foreman agent)

- [ ] "What are the top risks on FMD?" returns `get-project-risks` with real problem names.
- [ ] "Review sheet A-201 against egress rules" queues a review and reports its findings.
- [ ] "Propose a fix for the framing inspection sequencing" creates a proposal that appears in the approval queue.
- [ ] "Approve pending proposal …" asks for confirmation; nothing changes without approval.
- [ ] The three skills are visible: plan-code-review, inspection-readiness, approval-packet.

## C. Hardening

- [ ] A user without project permission sees a plain "Jira refused this action…" message, not a stack trace.
- [ ] Invalid resolver input shows "Invalid input: …".
- [ ] A background job that hits a 429 or 5xx shows "Temporary problem; retrying…", then finishes or fails cleanly after 3 attempts.
- [ ] LLM output is schema-checked (zod). On a bad response the job retries with feedback, then fails with a message.
- [ ] Teamwork Graph 429 or 5xx is retried twice.
- [ ] When the graph is unavailable, the briefing falls back to Jira-only context.
- [ ] Every write is in the audit log (Diagnostics → recent activity), with actor, action and item.
- [ ] Load the demo twice: it's idempotent, with no duplicate issues or links.
- [ ] Keyboard: tabs, buttons and heatmap cells can be reached with Tab and work with Enter.
- [ ] Visible focus ring, readable in light and dark themes.
- [ ] No console errors in the iframe on any screen.

## D. Uninstall

- [ ] Uninstall from Connected apps. The Jira data created by the demo (project FMD) stays, because it's the customer's data.
- [ ] Foreman's own storage (SQL and KVS) is removed by the platform.
