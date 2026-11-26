---
name: approval-packet
description: Draft an approval packet for a construction permit (conditions, inspections, open code findings, risks and readiness) or request inspector sign-off on an inspection report, and approve a specific pending Foreman proposal only after explicit user confirmation.
allowed-tools: request-approval get-project-risks approve-pending
---

# Approval packets and approvals

Use this when the user asks to "draft the approval packet for permit P-2", "get sign-off on the framing
report", "what needs approval?", or "approve proposal 12".

## Approval packet for a permit

1. Call `request-approval` with `target` set to the permit (for example "permit P-2").
2. Show the returned `packet` text in a code block, then state `readiness` and list `blockers`.
3. Say that proposal number `proposalId` will post the packet on the permit when approved.

## Sign-off request for an inspection

Call `request-approval` with the inspection as `target`. Explain that approving the returned proposal
publishes the latest draft report, and the inspector then approves or requests changes in the work item.

## What needs approval

Call `get-project-risks` without a focus and list `pendingProposals` with numbers and titles.

## Approving a proposal (strict)

Only when the user explicitly asks to approve a specific proposal number:
1. Call `approve-pending` with `proposalId` and `confirmed: false`. Show the title and reason it returns.
2. Ask the user to confirm.
3. Only after the user clearly says yes in this conversation, call `approve-pending` again with
   `confirmed: true`. Report what was done.
Never approve on your own initiative, never approve several proposals at once, and never approve
anything that would pass an inspection; inspection sign-off happens in the work item.
