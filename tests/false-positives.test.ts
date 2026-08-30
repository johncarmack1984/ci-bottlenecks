import { describe, it, expect } from "bun:test";
import { parseWorkflow } from "../src/parser.ts";
import { runRules } from "../src/runner.ts";
import { allRules } from "../src/rules/index.ts";
import type { Finding, ParsedWorkflow } from "../src/types.ts";

function check(yaml: string, opts?: { pedantic?: boolean; allWorkflows?: ParsedWorkflow[] }): Finding[] {
  const wf = parseWorkflow("test.yml", yaml);
  if (!wf) throw new Error("Failed to parse YAML");
  return runRules(allRules, opts?.allWorkflows ?? [wf], {
    audit: false,
    pedantic: opts?.pedantic ?? false,
  }).filter((f) => f.workflow === "test.yml");
}

function findByRule(findings: Finding[], rule: string): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

// Item 1: false-serialization false positives

describe("false-serialization: deploy-after-test", () => {
  it("does not fire on deploy needs test (not a CI job)", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm test
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [test]
    steps:
      - run: npm run deploy
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: publish needs build+test", () => {
  it("does not fire on publish after build and test", () => {
    const f = findByRule(check(`
name: Release
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build --release
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo test
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build, test]
    steps:
      - run: cargo publish
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: needs.*.result aggregator", () => {
  it("does not fire when consumer uses needs.*.result", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo test
  done:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build, test]
    if: always()
    steps:
      - run: |
          if \${{ contains(needs.*.result, 'failure') }}; then exit 1; fi
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: toJSON(needs)", () => {
  it("does not fire when consumer uses toJSON(needs)", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    if: always()
    steps:
      - run: echo \${{ toJSON(needs) }}
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: dynamic matrix from output", () => {
  it("does not fire when consumer uses needs.X.outputs in strategy.matrix", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  setup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      matrix: \${{ steps.set.outputs.matrix }}
    steps:
      - id: set
        run: echo "matrix={}" >> \$GITHUB_OUTPUT
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [setup]
    strategy:
      matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
    steps:
      - run: cargo build
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: reusable workflow producer", () => {
  it("does not fire when producer is a reusable workflow call", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    uses: ./.github/workflows/build.yml
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - run: npm test
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: runs-on from output", () => {
  it("does not fire when consumer uses needs.X in runs-on", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  setup:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      runner: self-hosted
    steps:
      - run: echo setup
  build:
    runs-on: \${{ needs.setup.outputs.runner }}
    timeout-minutes: 30
    needs: [setup]
    steps:
      - run: cargo build
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: environment url from output", () => {
  it("does not fire on environment-bound consumer", () => {
    const f = findByRule(check(`
name: Deploy
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm build
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    environment:
      name: production
      url: https://example.com
    steps:
      - run: deploy
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: artifact pattern download", () => {
  it("does not fire when download uses pattern matching uploads", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: build-\${{ matrix.target }}
          path: target/
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: 'build-*'
          merge-multiple: true
      - run: npm test
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization: still fires on pure CI with no consumption", () => {
  it("flags when test needs build but consumes nothing", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm build
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - run: npm test
`), "false-serialization");
    expect(f.length).toBe(1);
    expect(f[0]!.job).toBe("test");
  });
});

// Item 2: macos-not-needed false positives

describe("macos-not-needed: job name/id contains mac keyword", () => {
  it("does not fire when job id contains 'macos'", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  test-macos:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: cargo test
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });

  it("does not fire when job name contains 'macOS'", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  test:
    name: Test on macOS
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: cargo test
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: tauri-action", () => {
  it("does not fire with tauri-apps/tauri-action", () => {
    const f = findByRule(check(`
name: Build
on: push
jobs:
  build:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - uses: tauri-apps/tauri-action@v0
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: flutter build macos", () => {
  it("does not fire with flutter build macos", () => {
    const f = findByRule(check(`
name: Build
on: push
jobs:
  build:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: flutter build macos
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: upload-artifact", () => {
  it("does not fire when job uploads an artifact", () => {
    const f = findByRule(check(`
name: Build
on: push
jobs:
  build:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: ./scripts/build-macos.sh
      - uses: actions/upload-artifact@v4
        with:
          name: macos-build
          path: build/
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: electron-builder", () => {
  it("does not fire with electron-builder --mac", () => {
    const f = findByRule(check(`
name: Build
on: push
jobs:
  build:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: electron-builder --mac
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: pod trunk push", () => {
  it("does not fire with pod trunk push", () => {
    const f = findByRule(check(`
name: Release
on: push
jobs:
  release:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: pod trunk push MyLib.podspec
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed: severity is medium", () => {
  it("reports medium severity when firing", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: npm test
`), "macos-not-needed");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("medium");
  });
});

// Item 3: unneeded-full-checkout false positives

describe("unneeded-full-checkout: release-plz", () => {
  it("does not fire with release-plz/action", () => {
    const f = findByRule(check(`
name: Release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: release-plz/action@v0
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: goreleaser", () => {
  it("does not fire with goreleaser-action", () => {
    const f = findByRule(check(`
name: Release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: goreleaser/goreleaser-action@v5
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: git diff", () => {
  it("does not fire with git diff command", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: git diff HEAD~1
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: local composite action", () => {
  it("does not fire when job uses a local action", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./.github/actions/release
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: make/just/scripts", () => {
  it("does not fire with make command", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: make release
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });

  it("does not fire with ./scripts/ command", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: ./scripts/release.sh
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: semantic-release in run", () => {
  it("does not fire with npx semantic-release", () => {
    const f = findByRule(check(`
name: Release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npx semantic-release
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout: sonar", () => {
  it("does not fire with SonarSource action", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  sonar:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: SonarSource/sonarcloud-github-action@v2
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

// Item 4: double-trigger false positives

describe("double-trigger: tags-only push", () => {
  it("does not fire when push has tags but no branches", () => {
    const f = findByRule(check(`
name: Release
on:
  push:
    tags: ['v*']
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "double-trigger");
    expect(f.length).toBe(0);
  });
});

describe("double-trigger: PR types exclude synchronize", () => {
  it("does not fire when PR only triggers on closed", () => {
    const f = findByRule(check(`
name: CI
on:
  push:
  pull_request:
    types: [closed]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "double-trigger");
    expect(f.length).toBe(0);
  });
});

describe("double-trigger: patch preserves existing tags/paths", () => {
  it("includes existing tags in patch", () => {
    const f = findByRule(check(`
name: CI
on:
  push:
    branches: [main, develop]
    tags: ['v*']
    paths: ['src/**']
  pull_request:
    branches: [develop]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "double-trigger");
    expect(f.length).toBe(1);
    expect(f[0]!.patch).toContain("tags:");
    expect(f[0]!.patch).toContain("paths:");
  });
});

// Item 5: no-concurrency false positives

describe("no-concurrency: expression cancel-in-progress", () => {
  it("does not fire with expression-based cancel-in-progress", () => {
    const f = findByRule(check(`
name: CI
on: push
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "no-concurrency");
    expect(f.length).toBe(0);
  });
});

describe("no-concurrency: deliberate false with group", () => {
  it("does not fire with explicit cancel-in-progress false and a group", () => {
    const f = findByRule(check(`
name: Deploy
on: push
concurrency:
  group: deploy-prod
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: deploy
`), "no-concurrency");
    expect(f.length).toBe(0);
  });
});

describe("no-concurrency: tags-only release workflow", () => {
  it("does not fire on tags-only push", () => {
    const f = findByRule(check(`
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: publish
`), "no-concurrency");
    expect(f.length).toBe(0);
  });
});

// Item 6: install-no-cache false positives

describe("install-no-cache: expression path in actions/cache", () => {
  it("does not fire when cache path uses expression", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache@v4
        with:
          path: \${{ env.STORE_PATH }}
          key: pnpm-\${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: pnpm-
      - run: pnpm install
`), "install-no-cache");
    expect(f.length).toBe(0);
  });
});

describe("install-no-cache: local composite action", () => {
  it("does not fire when local action is used", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ./.github/actions/setup-node
      - run: npm ci
`), "install-no-cache");
    expect(f.length).toBe(0);
  });
});

describe("install-no-cache: moonrepo/setup-rust", () => {
  it("does not fire when moonrepo/setup-rust is used", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: moonrepo/setup-rust@v1
      - run: cargo build
`), "install-no-cache");
    expect(f.length).toBe(0);
  });
});

describe("install-no-cache: npm install -g excluded", () => {
  it("does not fire on npm install -g", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm install -g vercel
`), "install-no-cache");
    expect(f.length).toBe(0);
  });
});

// Item 7: no-timeout reusable workflow

describe("no-timeout: reusable workflow", () => {
  it("does not fire on reusable workflow call jobs", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    uses: ./.github/workflows/build.yml
`), "no-timeout");
    expect(f.length).toBe(0);
  });
});

// Item 8: cache-key-no-hash on cache/save

describe("cache-key-no-hash: actions/cache/save", () => {
  it("does not emit low finding for actions/cache/save", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache/save@v4
        with:
          key: cache-\${{ hashFiles('lock') }}
          path: build/
`), "cache-key-no-hash");
    expect(f.length).toBe(0);
  });

  it("still emits high for static key on cache/save", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache/save@v4
        with:
          key: my-static-key
          path: build/
`), "cache-key-no-hash");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("high");
  });
});

// Item 9: double-cache cargo/bin

describe("double-cache: cargo/bin not flagged", () => {
  it("does not fire when caching ~/.cargo/bin alongside rust-cache", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: Swatinem/rust-cache@v2
      - uses: actions/cache@v4
        with:
          key: tools-\${{ hashFiles('Cargo.toml') }}
          path: ~/.cargo/bin
          restore-keys: tools-
      - run: cargo test
`), "double-cache");
    expect(f.length).toBe(0);
  });
});

// Item 10: repeated-setup different runners/targets

describe("repeated-setup: different runners", () => {
  it("does not fire when jobs run on different OSes", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  test-linux:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build
      - run: cargo test
  test-macos:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build
      - run: cargo test
  test-windows:
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build
      - run: cargo test
`), "repeated-setup");
    expect(f.length).toBe(0);
  });
});

describe("repeated-setup: different toolchain versions", () => {
  it("does not fire when jobs use different rust toolchains", () => {
    const f = findByRule(check(`
name: CI
on: push
jobs:
  stable:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: stable
      - run: cargo build
      - run: cargo test
  nightly:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@nightly
        with:
          toolchain: nightly
      - run: cargo build
      - run: cargo test
  msrv:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: 1.70.0
      - run: cargo build
      - run: cargo test
`), "repeated-setup");
    expect(f.length).toBe(0);
  });
});

// Item 11: suppression on line above and within step

describe("suppression: line above", () => {
  it("suppresses job when comment is on the line above", () => {
    const yaml = `name: T
on:
  push:
    branches: [main]
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  # ci-bottlenecks: ignore[no-timeout]
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("test.yml", yaml);
    const f = runRules(allRules, [wf!], { audit: false, pedantic: false });
    const timeouts = f.filter((finding) => finding.rule === "no-timeout");
    expect(timeouts.some((t) => t.job === "build")).toBe(false);
    expect(timeouts.some((t) => t.job === "other")).toBe(true);
  });
});

describe("suppression: within step range", () => {
  it("suppresses when comment is on a line within the step", () => {
    const yaml = `name: T
on:
  push:
    branches: [main]
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@main # ci-bottlenecks: ignore[unpinned-action]
      - uses: some/action@main
`;
    const wf = parseWorkflow("test.yml", yaml);
    const f = runRules(allRules, [wf!], { audit: false, pedantic: false });
    const unpinned = f.filter((finding) => finding.rule === "unpinned-action");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.step).toBe(1);
  });
});
