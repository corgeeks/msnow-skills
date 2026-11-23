# Review work item #{{item_id}}: {{title}}

You review another model's change. Do not modify, create, or delete any files, and do not commit. Changes you make will be reverted and reported.

## Work item

{{body}}
{{#spec_path}}
## Specification

Spec file: `{{spec_path}}`

{{spec}}
{{/spec_path}}
{{#human_notes}}
## Additional requirements from the human (these override the item body where they conflict)

{{human_notes}}
{{/human_notes}}
## Diff (`origin/main...HEAD`)

```diff
{{diff}}
```

## Last passing test output (`{{test_cmd}}`)

```
{{test_output}}
```

## Task

Review the diff against the spec's acceptance criteria and its Out of Scope section. Check correctness, missing criteria, and scope creep. Run the test command (`{{test_cmd}}`) if useful.

## Verdict

End your reply with exactly one fenced `json` block, and nothing after it:

```json
{ "verdict": "approve" | "changes", "findings": [{ "severity": "blocking" | "advisory", "text": "..." }] }
```

`findings` lists concrete, actionable problems (empty on approve). Each has a severity:

- `blocking`: a correctness, security, data-loss, or spec-violation problem in this change.
- `advisory`: everything else: hardening, style, hypothetical threats outside the stated threat model, follow-ups. Advisory findings go to the human at the merge gate and never trigger rework.

Use `changes` only if at least one finding is blocking; otherwise `approve`, listing any advisory findings.
