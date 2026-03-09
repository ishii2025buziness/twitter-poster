# AGENTS.md

This repository is a minimal harness for AI-assisted work.

## Purpose

- Automate posting to Twitter/X.
- Keep work reproducible.
- Keep intermediate decisions visible.
- Make "done" explicit before claiming completion.

## Working Loop

Every task follows this loop. Do not skip steps.

1. **Assess** — Read `progress/current.md`. Check git log. Understand where things stand.
2. **Advance** — Pick one incomplete item. Make the smallest meaningful change.
3. **Tidy** — Clean up formatting, naming, and documentation touched by the change.
4. **Verify** — Run `./tools/harness self-check`. Fix any failures before proceeding. Then check that the next agent could resume from `progress/current.md` alone.
5. **Record** — Update `progress/current.md` (Key Paths, Last Session, Resume Here, Next Actions, Blockers, Risks, Last Verified). Record decisions in `docs/`.

## Working Rules

- Read this file before starting substantial work.
- Follow the Working Loop for every task.
- Put durable decisions and research outcomes in `docs/`.
- Put current status and next actions in `progress/current.md`.
- Treat `progress/current.md` as the handoff contract for the next agent. Record the exact files and commands needed to resume.
- Use `./tools/harness self-check` to validate compliance before marking any task done.
- If a task is risky, destructive, or ambiguous, stop and surface the risk.

## Blockers

A blocker is an obstacle the agent cannot resolve on its own:

- Permission or access restrictions
- Infrastructure or environment issues
- External service dependencies (Twitter API credentials, rate limits)
- Decisions that require human judgement

When a blocker is detected:

1. Stop work on the blocked task immediately.
2. Document the blocker in `progress/current.md` under `## Blockers` with enough detail for a human to act on it.
3. Notify the user. Do not attempt workarounds that exceed the agent's authority.
4. Move to other unblocked tasks if available.

## Definition of Done

A task is done only when all of the following are true:

- The requested change is implemented or the blocker is clearly documented.
- Relevant decisions are recorded in `docs/`.
- `progress/current.md` is updated (Last Session, Next Actions, Blockers, Risks).
- `progress/current.md` contains enough concrete handoff detail for the next agent to resume without chat history.
- `./tools/harness self-check` has passed, or the reason it could not be run is documented.

## Directory Contract

- `docs/`: research notes, design decisions, and permanent documentation
- `progress/`: current execution state, next actions, blockers, and risks
- `tools/harness`: central compliance checker
