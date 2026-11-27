# Demo video: script and shot list

**Target length:** 4:45 (the limit is under 5:00). Record at 1920×1080 in the light theme, on the
fresh-site demo project FMD. The narration is 514 words, about 3:40 at 140 wpm, which leaves room for pauses on the results.
Upload to YouTube as **Public**.

## Before recording

- [ ] Fresh site, installed from the production install link, with the demo loaded.
- [ ] Monitor run once, so the digest has data.
- [ ] Code review for A-201 already run once, so it can be shown instantly. Re-run it live if time allows.
- [ ] I2 report generated but **not** signed off.
- [ ] Framing proposal (Reschedule I5) still pending in the Approval queue.
- [ ] Demo decisions and spec pages added, so the Context tab is full.
- [ ] Rovo chat open in a second tab with the Foreman agent selected.
- [ ] Browser zoom at 110%, bookmarks bar hidden, notifications off.

## Shot list

| # | Time | Shot | On screen / action | Lower-third caption |
|---|---|---|---|---|
| 1 | 0:00 | Title card | "Foreman: the AI operating layer for construction" on a dark background | — |
| 2 | 0:05 | Problem b-roll / slides | Three cards: *Failed inspection → re-inspection fee + idle crew* · *Permit stuck in review → every trade slips* · *Report disagrees with plans → defect gets buried* | Delays here cost real money |
| 3 | 0:30 | Jira project → Apps → Foreman | Onboarding checklist; click **Load demo project**; progress steps (speed-ramp 4×) | Zero setup: one click |
| 4 | 0:50 | Command Center overview | Risk score, heatmap (Level 2 / MEP hot), open problems list | 7 planted problems found |
| 5 | 1:05 | Timeline | Hover I5 bar sitting before I4; red sequence marker; P1 expiry flag | Critical path |
| 6 | 1:20 | Issue → Code review | A-201 findings; zoom in on the IBC 1020.5 citation and the verbatim quote "55 ft dead-end corridor" | Cited. Quoted. Verified. |
| 7 | 1:40 | Issue I2 → Field evidence & report | Split view: click "Bar size and spacing" → photo and note highlight; red **conflict** chip (#4 @ 18 in. vs #5 @ 12 in.) | Evidence, not guesses |
| 8 | 2:00 | Approval queue | Proposal "Reschedule I5…" with its source "Proposed by the Foreman monitor" and its reason | — |
| 9 | 2:15 | **Human approval** | Cursor pauses over **Approve**; click; success banner; cut to the Jira issue showing the new date | A person decides |
| 10 | 2:30 | Audit log | Settings → recent activity: actor, action, item | Every change audited |
| 11 | 2:40 | Rovo chat | Type "What's blocking our framing inspection?"; agent answers with I4, I5 and the punch item | Foreman in Rovo |
| 12 | 3:05 | Rovo chat | "Propose a fix" → the agent creates a proposal and says it needs approval; cut to the queue showing the new item | Agents propose, people approve |
| 13 | 3:20 | MCP / skills | Quick pan of the manifest showing `rovo:mcp` + `skills/*/SKILL.md` | Same 6 tools over MCP |
| 14 | 3:30 | Issue → Context tab | Side by side: briefing *without* the graph vs *with* it (people, decisions, spec page) | Teamwork Graph context |
| 15 | 3:55 | Connector | Command Center → City permit portal records → **Sync portal records now** → count of objects written | Contributing to the graph |
| 16 | 4:10 | Confluence | Signed-off inspection report page | Published and signed off |
| 17 | 4:20 | Closing card | "Built for general contractors, owner's reps and project managers" + Runs on Atlassian badge + GitHub URL | — |
| 18 | 4:40 | End | Logo | — |

## Narration

**[0:00 – Problem]**
On a construction project, the schedule often doesn't depend on the crew. It depends on the
permit office and the city inspector. Book the framing inspection before the slab passes, and you
pay a re-inspection fee while a crew stands around. Leave a permit in review for two weeks, and
every trade behind it slips. Sign off a rebar report that disagrees with the drawings, and a
defect gets poured into concrete. Teams already track all of this in Jira. What they don't have
is someone who knows the code and the sequence, watching it all the time.

**[0:30 – Setup]**
This is Foreman, a Forge app that runs entirely on Atlassian. One click loads a demo project:
Riverside Commons, a five-storey mixed-use building, with permits, inspections, RFIs, plan sheets
and field evidence.

**[0:50 – Monitor]**
The monitor scans the project every hour. It has found seven problems. The framing inspection is
booked before the slab inspection has passed. The MEP permit has been stuck in review for twelve
days. The foundation permit expires in two weeks. The heatmap shows where the risk sits, at
Level 2 and in MEP, and the timeline shows the critical path.

**[1:20 – Code review]**
Next, plan review. Foreman checks sheet A-201 against thirty-six building-code rules. Every
finding cites the code section and quotes the drawing word for word: a fifty-five-foot dead-end
corridor where the limit is fifty. If the AI can't quote the sheet, the finding is thrown out.

**[1:40 – Verified report]**
Here's the rebar inspection. Jira says Passed. Foreman builds the report from the evidence, and
every line links to the photo or note behind it. It flags a conflict: the inspector saw number
four bars at eighteen inches, but S-101 calls for number fives at twelve. That's caught before
anyone signs.

**[2:00 – Human approval]**
Foreman never changes Jira on its own. It proposes. Here it suggests moving the framing
inspection until after the slab passes, and explains why. A person approves it, the date changes
in Jira, and the audit log records who approved it.

**[2:40 – Rovo]**
The same intelligence is in Rovo chat. "What's blocking our framing inspection?" The Foreman
agent pulls in the live risks: the slab inspection, and the punch item holding it up. "Propose a
fix." It creates a proposal, which goes into the same approval queue. The six tools and three
skills behind the agent are also available as an MCP server, so other agents can use them too.

**[3:30 – Teamwork Graph]**
Context is what makes the answer useful. Without Teamwork Graph, the briefing is generic. With
it, Foreman knows who decided to resequence the work, which spec page governs the rated corridor
walls, and which earlier inspection failed for the same reason. And it works in both directions:
our connector writes city permit portal records into the graph, linked to the right permits.

**[4:10 – Impact]**
The report is signed off and published to Confluence. Foreman is for general contractors,
owner's representatives and project managers running permit-heavy work. It catches failed
inspections, stalled permits and buried defects before they cost money, inside the tools they
already use. Nothing leaves Atlassian, and nothing changes without a person.

Foreman: the AI operating layer for construction.

## Recording tips

- Record each section separately and narrate over it afterwards, so the timing is easier to control.
- Speed up the demo loading and job progress (show a "4×" badge), but never the results.
- Keep the cursor still while talking about something on screen. Zoom in (to 150%) on citations and conflict chips.
