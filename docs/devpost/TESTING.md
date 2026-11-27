# Testing instructions for judges

**Install link:** `<paste from Developer Console → Distribution>`

**You need:**
- An Atlassian Cloud site where you are an admin. A free site is fine.
- Jira on that site. Confluence is optional and only needed to publish reports.
- Rovo enabled (it's on by default on new sites).

**Time:** about 10 minutes. No configuration, API keys or sample files are needed.

## Step 1: Install and load the demo (about 2 min)

1. Open the install link, choose your site, and install on **Jira**. Optional: open the link again and install on **Confluence**.
2. In Jira, open any project and go to **Apps → Foreman**. Select **Allow access** once.
3. Select **Load demo project**.

**Expected:** a progress checklist runs for about 60–90 s. When it finishes, project **FMD "Riverside Commons"** (a 5-storey mixed-use building) exists, containing:
- permits, inspections, RFIs, punch items and code findings;
- 6 Foreman fields;
- dependency links;
- plan sheets and field evidence.

If you reload during the seed, select **Resume loading demo project**.

## Step 2: Find the risks and approve a fix (about 3 min)

1. In the Command Center, select **Run monitor now**.
2. Open **Approval queue**, read the proposal for the framing inspection, and select **Approve**.

**Expected after the scan:**
- The **risk score** is above 0, and the **heatmap** is hottest at Level 2 and MEP.
- The **timeline** shows the critical path.
- **Problems** lists the 7 planted issues:
  - framing inspection I5 booked before the slab inspection I4 passes;
  - MEP permit stuck in review for 12 days;
  - rebar inspection I2 marked Passed while its report contradicts S-101;
  - RFI unanswered for 9 days;
  - contractor hasn't acknowledged an assignment;
  - foundation permit expires in 14 days;
  - MEP rough-in waiting on an unapproved permit.

**Expected after approving:** the framing inspection is rescheduled in Jira and recorded under **Settings → Health check and recent activity**. A rejected proposal changes nothing.

## Step 3: Code review, verified report, Rovo and Teamwork Graph (about 5 min)

### Code review

Open the **Code Finding** for sheet A-201 in FMD and go to the issue panel's **Code review** tab. Run the review on **A-201**.

**Expected:** findings cite IBC sections and quote the sheet word for word, for example the 55 ft dead-end corridor against the 50 ft limit (IBC 1020.5).

### Verified report

Open the **rebar inspection** (I2) and go to **Field evidence & report** → **Generate verified report**.

**Expected:**
- Each checklist line has a verdict and links to its evidence.
- Bar size and spacing is flagged as a **conflict**: #4 @ 18 in. observed against #5 @ 12 in. on S-101.
- Sign off. If Confluence is installed, publish the report to the *Foreman Inspection Reports* space.

### Rovo

Open **Rovo chat**, choose the **Foreman** agent, and ask: *"What's blocking our framing inspection?"*, then *"Propose a fix."*

**Expected:** the answer names I4, I5 and the punch item that blocks the slab. The new proposal appears in the Approval queue and waits for a person to approve it.

### Teamwork Graph

On the framing inspection, open the **Context** tab and select **Add demo decisions and spec pages**.

**Expected:** **People involved**, **Who decided what** and **Relevant specs** fill in, and the briefing shown with the graph is more specific than the one without it.

## Optional

- **City permit portal connector** (needs an admin): go to *Apps → Connected apps → Foreman → Connections*, connect it, then select **Sync portal records now** in the Command Center. Portal records then appear in Teamwork Graph, linked to the permits.
- **MCP:** the same 6 tools are exposed as the *Foreman Construction* MCP server.

## Troubleshooting

| What you see | Fix |
|---|---|
| "Allow access" keeps appearing | Accept it; it's a one-time consent per user for asUser calls |
| "Confluence unavailable" | Install Foreman on Confluence too, or skip publishing |
| Rovo agent not listed | Enable Rovo in site admin, then wait a minute after install |
| A job shows "Temporary problem; retrying…" | Jira is rate limiting; the job retries on its own |
