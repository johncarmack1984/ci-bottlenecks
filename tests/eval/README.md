# Eval corpus

A permanent, scored, per-rule test suite for ci-bottlenecks accuracy. Every case is a synthetic workflow YAML file with an embedded manifest declaring what the rules should do.

## Manifest grammar

Each case file starts with comment lines parsed as metadata:

```yaml
# eval: rule=false-serialization expect=silent kind=fp
# eval: rule=no-timeout expect=fire kind=tp jobs=build count=1
# why: deploy-after-test is ordering-only, not a CI consumer
# source: pattern from GitHub docs "Deploying to GitHub Pages"
```

### `# eval:` fields

| Field | Values | Required | Meaning |
|-------|--------|----------|---------|
| `rule` | rule id | yes | Which rule this assertion is about |
| `expect` | `fire` / `silent` | yes | Whether the rule should produce findings |
| `kind` | `tp` / `fp` / `fn` / `miss` | yes | See "Four kinds" below |
| `jobs` | comma-separated job ids | no | Which jobs must be flagged (for `fire`) |
| `count` | integer | no | Exact number of findings expected |
| `pedantic` | `true` | no | Run with pedantic rules enabled |
| `status` | `xfail` | no | Case currently fails; accepted as known gap |

Multiple `# eval:` lines are allowed in one file for testing different rules against the same fixture.

### `# why:` and `# source:`

- `why` explains what the case tests in one sentence.
- `source` names where the pattern comes from (GitHub docs, tool README, estate observation).

## Four kinds

- **tp** (true positive): The rule must fire. This tests detection capability.
- **fp** (false positive guard): The rule must stay silent. This tests precision — real-world patterns that should NOT be flagged.
- **fn** (false negative): The rule SHOULD fire on this pattern but currently does not. Marked `status=xfail` if the gap is accepted.
- **miss**: A plausible real-world shape the rule does not yet model. Expectation stated; outcome may go either way.

## xfail / xpass discipline

Mark a case `status=xfail` when you know the rule gets it wrong but fixing the rule is a separate task. The suite:
- **Reports** xfail cases but does **not fail** CI on them.
- **Fails** CI with "XPASS — promote this case" if an xfail case starts passing. This ensures gaps get closed deliberately: fix the rule, then remove `status=xfail` to lock in the improvement.

The list of xfails IS the next fix queue.

## Audit-tier cases

Audit rules need timing data. Place a sibling JSON file with the same base name:

```
tests/eval/cases/critical-path/basic-chain.yml
tests/eval/cases/critical-path/basic-chain.timing.json
```

The JSON follows the `WorkflowAuditData` schema (`{ runs: RunData[] }`).

## Adding a case when a user reports a false positive

Every FP report becomes a case before it becomes a fix:

1. Create `tests/eval/cases/<rule-id>/<descriptive-name>.yml` with the manifest header.
2. Set `kind=fp expect=silent`. If the rule currently fires on it, add `status=xfail`.
3. Run `just eval-score` to confirm it shows up in the scorecard.
4. Fix the rule. The xfail case will become an xpass, failing CI.
5. Remove `status=xfail` to promote it.
6. Commit both the case and the fix.

## Running

```sh
bun test tests/eval/eval.test.ts    # run all eval cases
just eval-score                      # print scorecard table
just eval-score --json               # write scorecard.json and print JSON
```

## Directory structure

```
tests/eval/
  cases/
    no-timeout/
      basic-missing.yml
      has-timeout.yml
      ...
    critical-path/
      basic-chain.yml
      basic-chain.timing.json
      ...
  eval.test.ts        # test runner
  scorecard.json      # committed; diffs show accuracy movement
  README.md           # this file
```
