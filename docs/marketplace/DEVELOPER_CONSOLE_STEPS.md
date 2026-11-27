# Developer Console steps (done by the app owner)

Only the app owner can do these steps; they can't be scripted. The production environment is
already deployed (v2.1.0, eligible for **Runs on Atlassian**).

App: `ari:cloud:ecosystem::app/53d4112c-bcbe-4a7e-ade7-a44df94a6995`
Console: https://developer.atlassian.com/console/myapps/

## 1. Create the install link (Start sharing your app)

1. Open the app in the Developer Console, then go to **Distribution** and select **Edit** under *Distribution controls*.
2. Choose **Sharing**, not "Sharing within organization", because judges are outside your organization.
3. Fill in the app details:
   - **Vendor name:** your name or team.
   - **Privacy policy URL:** host `docs/marketplace/PRIVACY_SECURITY.md`, for example as a GitHub link to the file.
   - **Terms of service / end-user terms URL:** a GitHub link to the repo README is fine for a hackathon.
   - **Support contact:** an email address or the GitHub issues URL.
   - **Personal data:** answer **Yes**. The app stores Atlassian account IDs in the audit log and in sign-offs. Point the answers to `DATA_HANDLING.md`.
4. Under the products to install on, select **Jira** only. Confluence is optional in the manifest (`compatibility`), and requiring both would block sites without Confluence.
5. Select **Save changes** and copy the **installation link**.
6. Paste the link into the Devpost submission and into `README.md` under "Install".

> Don't add a `licensing` block to the manifest and don't submit a Marketplace listing before judging.
> Either one disables the install link (see "Distribute your apps").

## 2. Check the production environment

- Go to **Environments → Production**. The deployed version should be 2.1.0 and the badge should say **Runs on Atlassian**.
- **Permissions:** the scope list should match `manifest.yml` (19 scopes, no egress).
- **Rovo:** the agent, 6 actions, 3 skills and the MCP server all appear under modules.

## 3. Verify on a fresh site (the judges' path)

1. Create a free site at https://www.atlassian.com/try/cloud/signup and add Jira and Confluence. Use a different account or org from the dev site.
2. In the site's **Admin**, make sure Rovo is enabled under *Settings → Atlassian Intelligence / Rovo*. New Cloud sites have it on by default.
3. Open the install link as the site admin, choose the site, and choose **Jira**. Approve the permissions.
4. Optional: install on **Confluence** from the same link so reports can be published.
5. In Jira, open any project, then go to **Apps → Foreman**. Select **Allow access** once; this is the user consent for Teamwork Graph and asUser calls.
6. Select **Load demo project**. This creates project `FMD` with about 40 work items, fields, links, plan sheets and evidence, all in roughly 60–90 s.
7. Then walk through the flow in `docs/QA_CHECKLIST.md` (section B).

### What isn't zero-setup (tell the judges)

| Item | Why | Workaround |
|---|---|---|
| **Allow access** consent | The platform asks each user once for asUser scopes | One click on first open |
| Rovo agent | Needs Rovo enabled on the site | It's on by default on new sites |
| Confluence publishing | Only works if the app is also installed on Confluence | Install from the same link; without it, the report stays in Jira |
| City permit portal connector | An admin connects it once (*Apps → Connected apps → Foreman → Connections*) | Optional; the demo works without it |
| Hourly monitor / daily digest | Scheduled triggers start after install | Select **Run monitor now** in the Command Center |

## 4. Marketplace listing (after judging, optional)

- Multi-product apps (Jira required + Confluence optional) can only be listed as **paid** apps
  (risk R13). **Decision needed:** either
  - list as paid with a free tier or trial, or
  - remove Confluence `compatibility`, publish reports via Jira attachments, and list as free.
- Listing as paid means adding `app.licensing.enabled: true` to the manifest, which disables the install link. So do this only after Codegeist judging closes.
- Then go to **Marketplace → Create listing**, using `LISTING.md`, `SCREENSHOTS.md`, `PRIVACY_SECURITY.md` and `DATA_HANDLING.md`.
- In the listing's privacy & security tab, fill in the **Data residency / Runs on Atlassian** answers. They're all "Yes, hosted on Atlassian" because the app has no egress.
