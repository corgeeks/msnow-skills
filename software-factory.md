# software-factory

This is a plan to upgrade the PRD skill to a bonafide software factory.  See references:
- https://github.com/coleam00/ai-software-factory
- https://github.com/coleam00/Archon

## Objective

Set up a Software Development Lifecycle (SDLC) system.  It manages SDLC workflows; Workflows are essentially directed acyclic graphs (DAG) that have some beginning state and some ending state.  The purpose of the system are to determine the contents and steps in that graph; 

The abstract SDLC Loop:
- Intake: a ticket, prompt, alert, issue, or PR request.
- Plan: Turn the intent into design and tasks.
- Split: Order tasks by dependency and priority.
- Build: Agents work in parallel.
- Verify: Tests, CI, review agents; check the work.
- Merge: traditional end-state: result is that the body of work ends up where it is intended: a dependency update means a merge to `main`, a feature for an internal application means it's available for the user to use.
- Learn: Results feed into the next Loop.  The learning is saved.

## Principals Involved:

- Human: Brief and Approve.  Describes the problem, answers the planners questions, approves or supplied feedback to the planner's designs; approves the plan and every step.
- Planner: Grill, research, and plan.  Reads the code and systems, writes small steps with acceptance criteria and tests.  These are reviewed by other model families.
- Orchestrator: Runs the plan.  A service, not a Model.  Opens the Epic (Issues, tickets), starts a session per ready step, routes reviews back, merges and unblocks
- Executors: Builds one step each.  Cheapest and most efficient model that fits the task.


## Big SDLC loops made from smaller Loops

A prompt to update a dependency can be as simple as a basic "update, test, verify, merge".  But a prompt that results in the creation of a large umbrella plan can have loops that result in wireframes, design and platform decisions, prototypes, before any code is written.

## Components

Software Factory Core: Running service. The plan format, validation, step graph, service, inbox, and retro.  Upgrades the PRD skill hooks and schema.  The bash scripts become service code. sqlite database instead of PRD task yaml files.  React-based UI for navigation and review of Initiatives, Objectives, Epics, Issues, Tasks, Bugs.

Session Backend: aoe/herder

Harness: Pi, oh-my-pi (what I use)

Models: whatever is available, like Claude subscription; including local models available through llamacpp, openllm, or discoverable through llmfit.

Roles and Skills: Planners, executors, judges, research.

Tools: deterministic (non-llm) tooling to accelerate and backstop the models: graphify, codebase-memory-mcp, language server protocols.  

Work Systems: Github, JIRA (if available), Confluence (if available)

# Goal

As a user, I want to tell my agent/harness "I want to build some feature into the system".  Using software-factory, the harness will work _with me_ to build out the plan, research, wireframe, and prototype, build knowledge, and iterate towards a solution.  The SDLC loop will build the plan; and once the planning is reviewed and approved, it will build what has been planned.  The deliverable of part of a design session could be a claude-design mockup, which then feeds into planning to build actual components, pages, subsystems, and functions.