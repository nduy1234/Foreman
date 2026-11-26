---
name: plan-code-review
description: Review a construction plan sheet (for example A-201, S-101, FP-101) against a curated building-code rule pack covering egress, fire separation, accessibility, structural notes and permit prerequisites, and turn failures into approvable follow-ups.
allowed-tools: review-plan-against-code propose-resolution
---

# Plan sheet code review

Use this when someone asks to check, review or audit a plan sheet or drawing against code, or asks
whether a sheet meets egress, fire, ADA/accessibility, structural or permit requirements.

## Steps

1. Identify the sheet number (A-201, S-101, FP-101...). If the user did not give one, ask.
2. Map the user's topic to a focus: exits/corridors/travel distance -> `egress`; rated walls,
   firestopping, sprinklers -> `fire separation`; ADA, ramps, door hardware -> `accessibility`;
   rebar, concrete, footings -> `structural`; submittals, documents -> `permit`. No topic -> omit focus.
3. Call `review-plan-against-code` with `sheetId` and `focus`.
   - `status: done`: report the summary line, then each finding with rule id, citation, the exact
     `evidence` quote in quotation marks, and the suggested fix. List passes in one line.
   - `status: queued`: tell the user the full review runs in the background and where results appear.
   - `ok: false`: relay the error message and what to do.
4. Only quote evidence returned by the action. Foreman already discarded findings whose quote was not
   found verbatim in the sheet; do not add new ones.
5. Offer follow-ups. For a failed egress or fire finding on an active inspection, you may offer to call
   `propose-resolution` (for example kind `notify` to the architect of record with the suggested fix).

## Wording

- Findings are review guidance for the project team; the building official has final authority.
- Never claim a sheet "passes code" overall; say which checked rules passed.
