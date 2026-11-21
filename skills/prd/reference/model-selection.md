# Model Selection for Tasks

## Overview

Many harnesses (Codex CLI, Cursor, opencode, Claude Code, and others) let a
different model run each task rather than locking a whole session to one. A
PRD's tasks are the unit that gets handed to a worker — a subagent, a human,
or another tool — so the task spec is the right place to record which model
fits, for whoever picks the task up next.

This is optional, advisory annotation, not a hard requirement. Some users
have no per-task model choice, or don't want to think about it — skip the
whole feature for them.

## Ask, don't assume

Model rosters differ by harness, by the user's plan/subscription, and change
often — a specific model recommendation baked into this skill would go stale
fast. Rather than hardcoding names, ask the user during planning (see
PlanPRD Step 9):

- *"Which harness will implement this PRD, and which models does it offer
  you?"* If you can already identify the harness this session is running in,
  name it and confirm rather than asking from scratch.
- If the user has no model choice available, or would rather not specify one
  per task, say so and skip Suggested Model entirely for this PRD.

Record the answer once per planning session as a Discussion Q&A on the PRD
(reuse the existing Discussion format) so it's visible and self-contained —
don't hide it in a cache file that could silently go stale between sessions.
For an umbrella, ask once on the umbrella PRD; children inherit the answer
without re-asking.

## Classify by tier, not by name

Rather than asking "which model" per task, first decide which **tier** the
task needs — the model name gets filled in from whatever the user named for
that tier:

| Tier | Fits tasks that are... | Examples |
|------|-------------------------|----------|
| **Heavy** | Architecture-sensitive, ambiguous trade-offs, security- or correctness-critical, tricky algorithms or concurrency, cross-cutting refactors | Designing a new auth flow, a data migration with edge cases, a concurrency bug fix |
| **Standard** | Typical implementation following an established pattern — the default for most tasks | A CRUD endpoint, a new form, a straightforward integration |
| **Light** | Mechanical, repetitive, low-ambiguity | Boilerplate, config/formatting changes, doc updates, research lookups (PlanPRD Step 6 already suggests a fast model for research) |

Most PRDs skew Standard. Reserve Heavy for tasks where a wrong judgment call
is expensive to unwind; reserve Light for tasks where more reasoning
wouldn't change the outcome.

## Axes, if the user wants to reason about which model fills a tier

Picking which concrete model fills a tier doesn't reduce to one scalar —
different users weigh these differently (a solo dev minimizing spend and a
team minimizing wall-clock time will pick differently from the same roster):

- **Capability / reasoning depth** — can it handle this task's ambiguity?
- **Agentic tool-use reliability** — does it drive a coding-agent loop (edit,
  run, iterate) well, not just answer in chat?
- **Cost** per task.
- **Latency / speed**.
- **Context window** — does the task's spec plus relevant code fit comfortably?

Don't resolve these to a ranking on the user's behalf. Surface the tradeoff
if it's relevant to a specific task, otherwise default to Standard and move
on.

## Recording the suggestion

Each generated task spec gets a short **Suggested Model** note (see
`reference/task-spec.md`): the tier, the concrete model if the user named one
for that tier, and a one-line reason tied to the task's nature. Omit the
section entirely when the user's harness doesn't support per-task model
selection, or when they haven't stated a roster.

## Using the suggestion at work time

When a harness's dispatch mechanism lets the orchestrator pick a model for a
delegated task (e.g. Claude Code's Task/Agent tool), WorkPRD reads the task's
spec before dispatching and uses its Suggested Model in place of the generic
default when present — see WorkPRD.md, "Dispatching a worker".
