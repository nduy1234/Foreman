# Marketplace listing copy

**App name:** Foreman
**Tagline (≤ 80 chars):** The AI operating layer for construction projects in Jira and Confluence
**Category:** Project management · Workflow · AI
**Hosting:** Cloud, Forge, Runs on Atlassian

## Summary (≤ 250 chars)

Foreman reviews plan sheets against building code, turns field evidence into verified
inspection reports, and watches permits and inspections for risk. Every change waits for human
approval. It runs on Atlassian: your data never leaves it.

## Highlights

1. **Plan-vs-code review.** Checks plan sheets against 36 IBC/ADA/NFPA/ACI rules. Each finding
   cites the code section and quotes the sheet text word for word, and becomes a Code Finding
   work item.
2. **Verified inspection reports.** Builds a report from photos, notes and checklists in which
   every line points to its evidence and contradictions are flagged. An inspector signs it off
   and it's published to Confluence.
3. **Workflow monitor.** Hourly scans catch out-of-sequence inspections, stalled permits,
   expiring permits, unanswered RFIs and unacknowledged assignments. Each project gets a risk
   score, a heatmap, a timeline and a daily digest.
4. **Approval queue.** Foreman never edits Jira on its own; it only proposes. People approve,
   and every action is audited.
5. **Rovo agent and MCP.** Ask "what's at risk on Level 2?" or "review A-201 for egress" in Rovo
   chat, or use the same six tools from any MCP client.
6. **Teamwork Graph.** Pulls in the people, decisions, specs and similar work behind each work
   item, and writes city permit portal records into the graph.

## Description

Construction teams already run permits, inspections, RFIs and punch lists in Jira, with the
specs in Confluence. Foreman adds an AI layer on top that knows building code and the order work
has to happen in.

- **Before work starts:** run a plan sheet through code review and get cited findings, not
  guesses.
- **During inspections:** attach photos and notes, and Foreman drafts a report in which each
  claim is traced to evidence and anything that disagrees with the plans is flagged.
- **Every hour:** the monitor checks the sequence of work and permit status, so problems come up
  before they turn into failed inspections or idle crews.

Nothing changes without a person: Foreman proposes, you approve. It uses Atlassian-hosted AI
(Forge LLMs), Forge SQL and Forge storage, with no outside servers.

**Try it in two minutes:** open Foreman in any Jira project and select **Load demo project** to
get a fully seeded mixed-use building, "Riverside Commons", with seven planted problems to find.

## Links

- Documentation: GitHub README
- Support: GitHub issues
- Privacy: `PRIVACY_SECURITY.md`
