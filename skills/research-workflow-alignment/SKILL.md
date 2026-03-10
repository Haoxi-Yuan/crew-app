---
name: research-workflow-alignment
description: Align research-team outputs across literature review, data analysis, manuscript drafting, and project orchestration. Use when Codex needs to reconcile conflicting numbers or draft versions, determine the current source of truth, assign clear handoffs between specialist agents, or produce concise integration memos that keep a research-and-paper-writing team on a stable track.
---

# Research Workflow Alignment

## Overview

Use this skill to act as the project's integrator.
Build a current picture of the team state, decide which files and numbers are authoritative, identify gaps or drift, and push the next clean handoff without taking over the specialists' jobs.

## Workflow

### 1. Build the current state first

- Read recent team chat before making assignments.
- List shared files, then read only the newest files that matter for the current question.
- Prefer the smallest sufficient context window:
  - recent experiment channel messages for ongoing coordination
  - DM with `author` only when user intent or final approval matters
  - the latest specialist draft, not every historical version
- Build a short internal state:
  - current research question or section
  - current source-of-truth files
  - unresolved conflicts
  - next blocking dependency

### 2. Decide the source of truth explicitly

- Never merge outputs implicitly.
- For each key claim, number, table, or figure, decide which file currently governs it.
- Use this precedence unless the chat says otherwise:
  1. latest specialist output that directly owns the fact
  2. latest integrated manuscript or section draft
  3. older drafts and summaries
- If two files disagree, call it out directly instead of averaging or guessing.

### 3. Look for alignment failures

- Check for:
  - number drift: manuscript text no longer matches analyst output
  - version drift: newer file exists but team is still citing an older draft
  - narrative drift: the section framing no longer matches the revised research design
  - handoff gaps: one agent is blocked because no explicit next input was named
  - decision gaps: the team is waiting on `author` or user approval but nobody has surfaced it clearly
- See [references/conflict-checklist.md](references/conflict-checklist.md) when you need a concrete checklist.

### 4. Issue minimal, directed handoffs

- Do not broadcast vague requests.
- Give each agent:
  - the exact input file or message to use
  - the exact output expected
  - the stopping condition
  - whether the result should go to chat or a shared file
- Prefer short Chinese coordination messages in team chat.
- Keep asks role-pure:
  - `researcher`: literature, citations, positioning
  - `data-analyst`: numbers, tables, figures, robustness checks
  - `paper-writer`: prose, section integration, argument flow
  - `author`: approval, intent confirmation, team-level decisions

### 5. Produce an integration memo when the state changes

- After a meaningful alignment pass, send a short update or save a shared file.
- Default memo structure:
  - current authoritative files
  - resolved conflicts
  - open blockers
  - next actions by owner
- Use the templates in [references/output-templates.md](references/output-templates.md).

## Working Rules

- Do not invent numbers, p-values, citations, or file status.
- Do not rewrite a specialist's core output unless the user or `author` explicitly asks.
- Do not take over manuscript drafting if the real need is coordination.
- Prefer pointing the team to the right existing file over generating another parallel draft.
- If the project has already pivoted, restate the new mainline in one sentence before assigning work.
- In group chat, be concise and operational. In shared files, be structured and explicit.

## Typical Outputs

- Short chat alignment update
- Conflict report
- Next-step assignment block
- Shared-file integration memo
- "Source of truth" summary for a section, figure, or table

## References

- Read [references/conflict-checklist.md](references/conflict-checklist.md) when checking misalignment.
- Read [references/output-templates.md](references/output-templates.md) when drafting coordination messages or integration memos.
