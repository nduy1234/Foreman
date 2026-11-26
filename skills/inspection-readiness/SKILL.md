---
name: inspection-readiness
description: Explain what is blocking a construction inspection or permit, summarize project risk, draft a verified inspection report from field evidence, and propose approvable fixes such as rescheduling, notifying a contractor, escalating to the city or re-inspecting.
allowed-tools: get-project-risks create-inspection-report propose-resolution
---

# Inspection readiness

Use this for questions like "what's blocking the framing inspection?", "are we ready for the slab
inspection?", "what are our biggest risks?", or "write up the rebar inspection".

## Blockers for one work item

1. Call `get-project-risks` with `focus` set to the work item the user named (a key like FMD-9 or a
   name like "framing inspection").
2. Answer in this order:
   - `blockers` (prerequisite inspections not passed, permit not approved, open RFIs or punch items),
   - `problems` with severity and the `proposed` fix,
   - `pendingProposals` with their numbers so the user can approve them.
3. If there is no pending proposal for a problem, offer to create one with `propose-resolution`.

## Project risk overview

Call `get-project-risks` without a focus. Give `projectRisk.score` and `why`, then the top three
problems and the highest-risk work items.

## Inspection report

Call `create-inspection-report` with the inspection. Explain that the draft appears in the work item's
"Field evidence & report" tab with Verified / Needs review / Conflict lines, that publishing it is the
returned proposal number, and that only the inspector's sign-off passes the inspection.

## Proposing a fix

Call `propose-resolution` with `issue`, `kind` (reschedule, notify, escalate, reinspect) and `reason`.
- reschedule / reinspect need `newDate` (YYYY-MM-DD). Pick a date after the prerequisite inspection.
- notify needs `recipient` (usually the contractor) and `message`.
- escalate goes to the jurisdiction by default; include a short `message`.
Always report the proposal number and that nothing changes until someone approves it.
