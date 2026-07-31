# Implementation Log Specification
# Defines the structure for tracking completed work

## Overview

The implementation log is a markdown file that documents completed work for a PRD. It lives alongside the PRD at `[prd-root]/[prd_name]/log.md` (see `log_path` from `scripts/get-task.sh`).

## Structure

New entries go at the **top** of the file (reverse chronological order).

```markdown
# Implementation Log

## [ISO 8601 Timestamp] - [Task Name]

**Status**: Completed | Blocked

**Summary**: Brief description of what was implemented or why it's blocked.

**Changes Made**:
- `path/to/file.ts` - Created: Description
- `path/to/other.ts` - Modified: Description
- `path/to/old.ts` - Deleted: Description

**Notes**: Any relevant context, decisions made, or deviations from the spec.

---

## [Earlier Timestamp] - [Earlier Task Name]

...
```

## Required Fields

### Timestamp
- Use ISO 8601 format: `YYYY-MM-DDTHH:MM:SS`
- Example: `2024-01-15T14:30:00`

### Task Name
- Must match the task name in `tasks.yaml`

### Status
- `Completed` - Task finished successfully
- `In Progress` - A checkpoint written mid-task so a later session can resume (see below)
- `Blocked` - Task could not be completed, requires attention

### Summary
- One to two sentences describing what was accomplished
- For blocked tasks, explain what prevented completion

### Changes Made
- List **every file** that was created, modified, or deleted
- Include brief description of each change
- Use consistent action labels: Created, Modified, Deleted

### Notes
- Document any decisions made during implementation
- Note any deviations from the spec and why
- Include relevant context for future reference

## Example Entry

```markdown
## 2024-01-15T14:30:00 - Implement user authentication middleware

**Status**: Completed

**Summary**: Created JWT-based authentication middleware with role-based access control.

**Changes Made**:
- `src/middleware/auth.ts` - Created: Main authentication middleware
- `src/types/auth.ts` - Created: Type definitions for auth tokens
- `src/config/auth.ts` - Modified: Added JWT secret configuration
- `tests/middleware/auth.test.ts` - Created: Unit tests for auth middleware

**Notes**: Chose HS256 algorithm for JWT signing as specified in constraints. Added rate limiting on token refresh endpoint as a security measure (not in original spec but aligns with security constraints).
```

## Resume Checkpoints (in-progress tasks)

A task can be interrupted before it finishes (token limits, crashes). To make work
resumable, the worker writes a **checkpoint** entry while the task is still
`in-progress`, and keeps it current as it makes progress. A resuming session reads
the most recent checkpoint plus the current code state to continue.

A checkpoint entry adds two fields:

- **Done so far** - What has already been changed and verified (so the next session does not redo it)
- **Resume from** - The concrete next step, plus any acceptance criteria still unmet

```markdown
## 2026-06-14T09:12:00 - Implement user authentication middleware

**Status**: In Progress

**Summary**: Building JWT auth middleware; partway through.

**Done so far**:
- `src/middleware/auth.ts` - Created: token verification + role check (compiles, unit tests pass)
- `src/types/auth.ts` - Created: token type definitions

**Resume from**: Wire the middleware into `src/server.ts` route registration, then
add the refresh-token endpoint. Acceptance criteria still unmet: rate limiting on
refresh; integration test for expired tokens.

**Notes**: Chose HS256 per constraints.
```

When the task finishes, the worker replaces the checkpoint's status with
`Completed` (or appends a final `Completed` entry) and sets the task status to
`completed`. Leave the task `in-progress` if work remains.

## Best Practices

1. **Log immediately** - Create entries as soon as tasks complete, not in batches

2. **Be specific** - Vague entries are not useful for debugging or understanding history

3. **Document decisions** - Future you (or other developers) will thank you

4. **Track blocked items** - Don't just skip them, document why they're blocked
