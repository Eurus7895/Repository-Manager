# Repository review policy (MVP 2 foundation)

Add `.repository-manager/review-policy.json` to a repository to define its own compliance rules. The review reads the file **from the commit being reviewed**, so each result stays tied to the policy in that commit. Changes to this file take effect after they are committed and the review is rerun. When the file is absent, compliance is `not_configured`, never `pass`.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "TEAM-CI-01",
      "description": "Release jobs use only the repository permissions needed by their steps.",
      "scope": { "include": [".github/workflows/*.yml", ".github/workflows/*.yaml"] },
      "severity": "high",
      "verification": "ai",
      "requiredEvidence": "Cite the workflow permissions, triggers and any step that uses a write credential."
    }
  ]
}
```

These are example rules, not built-in company requirements. Each rule needs a unique ID, nonempty description and evidence requirement, scope with one or more repository-relative patterns, severity (`critical`, `high`, `medium`, `low`) and verification (`static`, `ai`, `manual`). A manual rule needs evidence supplied outside the repository; lack of evidence is `insufficient_evidence`. The review engine and dashboard will use this contract in subsequent steps; this foundation only validates and loads the file.

Security review is independent of this configuration. Review results are advisory; a successful load does not constitute a compliance verdict.
