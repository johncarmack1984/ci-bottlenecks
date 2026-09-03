# ci-bottlenecks

Find performance problems in GitHub Actions pipelines.

**actionlint** checks correctness, **zizmor** checks security, **ci-bottlenecks** checks performance.

ci-bottlenecks is a linter for GitHub Actions workflows that catches common CI performance anti-patterns: missing timeouts, redundant triggers, uncached installs, unnecessary macOS runners, serialized jobs that could run in parallel, and more. It runs statically on your workflow YAML files, and optionally in audit mode against real run data from the GitHub API.

## Install

### CLI

```sh
# With bun
bunx ci-bottlenecks

# With npx
npx ci-bottlenecks
```

### GitHub Action

```yaml
- name: Run ci-bottlenecks
  id: cib
  uses: johncarmack1984/ci-bottlenecks@v0
  with:
    format: text,summary,sarif

- name: Upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.cib.outputs.sarif-path }}
```

## Usage

```
ci-bottlenecks [path] [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--audit` | Enable audit tier (pulls measured data from GitHub API) | off |
| `--pedantic` | Enable pedantic rules | off |
| `--runs N` | Maximum completed runs to sample per workflow for audit | 25 |
| `--format text\|json\|sarif\|summary` | Output format (repeatable) | text |
| `--fail-on high\|medium\|low\|info\|none` | Minimum severity to fail the check | none |
| `--repo owner/name` | Override repository detection for audit mode | - |
| `--record dir` | Write anonymized audit snapshots for eval fixtures | - |
| `--sarif-output path` | Write SARIF to a file instead of stdout | - |
| `-h, --help` | Show help and exit | - |
| `--version` | Print version and exit | - |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No findings at or above the `--fail-on` threshold |
| 1 | Findings found at or above the threshold |
| 2 | Error (no workflows found, parse failure, etc.) |

## Rules

### Static rules

These run against your workflow YAML files with no API access required. Each rule is tested by a scored eval corpus (`just eval-score`) tracking precision and recall per rule.

| ID | Severity | Description |
|----|----------|-------------|
| `no-timeout` | medium | Job without `timeout-minutes` (default is 6 hours) |
| `double-trigger` | high | Push and pull_request triggers overlap, causing duplicate runs |
| `no-concurrency` | medium | Workflow triggered on push/PR with no concurrency + cancel-in-progress |
| `cache-key-no-hash` | high/low | Cache key without `hashFiles` or dynamic component; missing `restore-keys` (low) |
| `double-cache` | medium | Redundant cache mechanisms in the same job |
| `unneeded-full-checkout` | low | Full git history checkout without steps needing it |
| `macos-not-needed` | medium | macOS runner used without macOS-specific work |
| `false-serialization` | medium | Job depends on another but consumes nothing from it |
| `repeated-setup` | medium | Multiple jobs repeat checkout + toolchain + build with no artifact hand-off |
| `no-path-filter` | low (pedantic) | Push/PR workflow without path filters |
| `matrix-max-parallel` | low (pedantic) | `max-parallel` limits matrix concurrency without obvious reason |
| `unpinned-action` | info | Action uses mutable ref (`@main`, `@master`, or no ref) |

### Audit rules

These require `--audit` and pull measured run data from the GitHub API.

| ID | Severity | Description |
|----|----------|-------------|
| `critical-path` | info/medium | Critical path through the job dependency graph (medium if >2× longest job) |
| `flaky-or-hanging` | high | Job with high duration variance or frequent cancellations |
| `queue-dominated` | medium | Jobs spend more time queued than running |
| `setup-dominated` | medium | Setup steps consume most of job time |
| `double-run-measured` | high | Two runs of the same workflow on the same SHA within 5 minutes |
| `install-no-cache` | medium | Package install without a cache mechanism, measured at 10s or more (see below) |

`install-no-cache` detects the install statically but only reports it once measured. The YAML shows whether an install has a cache, not whether a cache would pay: an `actions/cache` restore and save costs 2–4s per job on its own, and many installs finish in one. With `--audit` the rule measures the flagged job's install steps for that ecosystem, matched to the sampled runs by GitHub's step display name: a median of 10s or more reports at `medium` with the measured duration as evidence, and anything under is dropped. Only steps present in the workflow being linted are measured, so a step deleted since the runs happened cannot keep a finding alive; a step the runs do not contain (renamed, or no runs yet) is unmeasured and also dropped. `--pedantic` shows dropped detections as `info` traces.

## Suppression

Suppress a specific rule on a job or step by adding a comment on the same line, on any line within the step's YAML, or on the line directly above:

```yaml
# ci-bottlenecks: ignore[unneeded-full-checkout]
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
```

```yaml
steps:
  - name: Checkout
    uses: actions/checkout@v4 # ci-bottlenecks: ignore[unneeded-full-checkout]
    with:
      fetch-depth: 0
```

Suppress all rules on a job:

```yaml
  build: # ci-bottlenecks: ignore
```

Suppress a rule for the entire workflow by placing the comment at the top of the file:

```yaml
# ci-bottlenecks: ignore[no-path-filter]
name: Release
```

## GitHub Action

### Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `path` | Path to the repository root | `.` |
| `audit` | Enable audit tier (pulls measured data from GitHub API) | `false` |
| `runs` | Maximum completed runs to sample per workflow for audit | `25` |
| `pedantic` | Enable pedantic rules | `false` |
| `fail-on` | Minimum severity to fail the check (`high`, `medium`, `low`, `info`, `none`) | `none` |
| `format` | Output formats (comma-separated: `text`, `json`, `sarif`, `summary`) | `text,summary,sarif` |
| `token` | GitHub token for API access (audit mode) | `${{ github.token }}` |

### Outputs

| Output | Description |
|--------|-------------|
| `findings` | Number of findings |
| `sarif-path` | Path to the generated SARIF file |

## Testing and contributing

The project includes a scored eval corpus under `tests/eval/` that tests every rule against synthetic but realistic workflow fixtures. Run `just eval-score` to see per-rule precision and recall. Every false-positive report should become a case before it becomes a fix — see `tests/eval/README.md` for the manifest grammar and workflow.

## Roadmap

- **Log-derived cache hit rates** -- extension point for analyzing real cache statistics from job logs, enabling rules that detect caches that never hit or always miss.
- **SARIF upload** -- already supported (shown above); future work includes richer region and fix metadata in SARIF output.

## License

MIT
