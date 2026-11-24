Use software-factory to research, investigate, plan, review, approve, implement the following feedback items.  The goal is to start dogfooding software-factory in another project.

1. Gates

A "Gate" is a blocker or approval step.  It requires either a human, a review quorum, or a different model family to approve.

The gate UI must provide the context and content being reviewed.  For example:
- a UX review gate should show an animated wireframe/mockup of the process.
- A design review gate should show images, screenshots, mockups, videos of the design under review.
- Data flow design should propose mermaid diagrams.
- Code Review / PR should either provide link to the source control diff (github PR for example).

Like other harness prompts, it should allow for selection as well as feedback.

When iterating on UX or design patterns, the agents should be able to present options (if necessary).

2. Workflows

Use `reactflow` to visually describe the workflows that are planned, as well as their status.  Use "1. Gate" above to help iterate on design.

3. Compose big things from little things.

Example prompt: "I want to show gantt-style timelines/charts of this software-factory"
Can be broken down into smaller research processes and work processes:
- Research User Experience for interacting with timelines of different complexities.
- Research into how the current data model could support showing timelines.
- Prompts into how the data model might need to change.
- Design for the interfaces and components themselves.
- Refactor work to ensure we maintain code quality.
- The actual dispatch of agents to create code and tests.

4. Learning

Specific users, or specific repositories, may choose to use specific tools, plugins, or skills.  I may choose to use the `impeccable` skill to assist with UI design.  I might use a PR review quorum skill and determine specific agent personas.  Learning can be a loop in and of itself: "we should adopt a different process or new procedure" can include research, design, and decision-making.  This could be formalized in an Architecture Decision Record (ADR) committed to the repository.  Sometimes an external tool, like Claude Design, may be required.

Do not fall victim to the Dunning-Kruger effect.

5. Personal Database

Teams may want to have a personal sqlite database this is _not committed_ to the repo (git-ignored).  Therefore this system needs to be able to decide- or ask- when and how learnings should be recorded. 

1. UI feedback:
- "Work Items": filters (type, status) should be multiselect instead of single-selection: https://ui.shadcn.com/docs/components/base/combobox#multiple
- "Work Items": switch (https://ui.shadcn.com/docs/components/base/switch) to "show parents" if they are filtered out.
- "Work Items": need a project view, see 7. UX Feedback.
- "Work Items": needs opened_at, closed_at (primarily for sorting and organization)
- "Runs" e.g. http://localhost:7317/runs/11: The "Nodes" table could be a trace (https://ui.shadcn.com/docs/components/radix/trace) view instead. It could show the DAG via reactflow as well: the dag to show the plan, current state, and, the trace to show the current state.  
- "Work Items" single item view: Depends on, Dependents, Children, should be tables of issues and not 3 columns of lists.  Could be a single "issueTable" component.
- "Work Items" single item view should have these surfaces: Title, Metadata, Description, Acceptance Criteria, Depends On, Dependents, Children, Runs.  A surface is a container visully distincy from it's parent.  In light mode, the background would be grey, the first elevation surface would be white or near-white.  Please research content elevation, example from Atlassian: https://atlassian.design/foundations/elevation
- Use layout primitives (see https://atlassian.design/foundations/spacing/primitives)
- Use the High Performance HMI Handbook as the bible for design.  I own a PDF copy but I do not know if providing it as input is authorized.
  
  
1. UX Feedback:
- "Projects": we will want to have JIRA-like projects and project keys to organize and categorize scopes of work.  For example, INFRA "Infrastructure" to capture everything related to CI/CD, deployment, and hosting.  DESIGN "Design" for UI/UX focused feature work in how software-factory is presented through the react UI.  These will be specific to the project; ../the-three-towers will have AUDIO, ENGINE, UI, SYSTEMS, INFRA, etc.  Work Items will retain their numeric ID; but each project will have it's own 1-based sequence.
- Learning should help identify when a Project should be created.
- Approval and Feedback in the UI: Currently Gates are just read-only visualizations, they could be prompt-points for user (or agent) input.

1. "Currently Running"
- We need a top level tab, in addition to "Work Items" and "Gates", that visualizes what is currently running.  Use `reactflow` in 2. Workflows above.

1. Is this a Durable State Machine?

A lot of output I've followed reads a lot like a durable state machine.  I have to ask if we should be using something like restate (https://github.com/restatedev/restate)?

10. Resiliency across sessions.

We should be able to iterate on planning across multiple sessions and multiple days: the data saved to sqlite and the files should provide enough memory and context to easily pick up.

11. Documentation

I want to start dogfooding software-factory in another, already-existing project.  I need a README.md that tells me what to do.

12. Integration & repo maintenance

How do I use and work with this in a new repository?  What is the release-management plan?  What kinds of CI/CD does this need?  Publicly hosted on Github.  Need to add dependabot & security scanning; need to add MIT licence.