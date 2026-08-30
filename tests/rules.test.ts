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

describe("no-timeout", () => {
  it("flags job without timeout-minutes", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`), "no-timeout");
    expect(f.length).toBe(1);
    expect(f[0]!.job).toBe("build");
  });

  it("passes when timeout-minutes is set", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "no-timeout");
    expect(f.length).toBe(0);
  });
});

describe("double-trigger", () => {
  it("flags overlapping push + pull_request", () => {
    const f = findByRule(check(`
name: T
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "double-trigger");
    expect(f.length).toBe(1);
  });

  it("passes when push is default-branch-only", () => {
    const f = findByRule(check(`
name: T
on:
  push:
    branches: [main]
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

  it("flags when push has non-default branches", () => {
    const f = findByRule(check(`
name: T
on:
  push:
    branches: [main, develop]
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
  });
});

describe("no-concurrency", () => {
  it("flags push workflow without concurrency", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "no-concurrency");
    expect(f.length).toBe(1);
  });

  it("passes with concurrency + cancel-in-progress", () => {
    const f = findByRule(check(`
name: T
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`), "no-concurrency");
    expect(f.length).toBe(0);
  });

  it("skips schedule-only workflow", () => {
    const f = findByRule(check(`
name: T
on:
  schedule:
    - cron: '0 0 * * *'
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

describe("cache-key-no-hash", () => {
  it("flags static cache key", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache@v4
        with:
          key: my-static-key
          path: ~/.cache
`), "cache-key-no-hash");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("high");
  });

  it("passes with hashFiles in key", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache@v4
        with:
          key: cache-\${{ hashFiles('**/package-lock.json') }}
          path: node_modules
          restore-keys: cache-
`), "cache-key-no-hash");
    expect(f.length).toBe(0);
  });

  it("flags missing restore-keys (low severity)", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/cache@v4
        with:
          key: cache-\${{ hashFiles('lock') }}
          path: node_modules
`), "cache-key-no-hash");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("low");
  });
});

describe("double-cache", () => {
  it("flags rust-cache + manual cargo cache", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: Swatinem/rust-cache@v2
      - uses: actions/cache@v4
        with:
          key: rust-\${{ hashFiles('Cargo.lock') }}
          path: ~/.cargo
          restore-keys: rust-
`), "double-cache");
    expect(f.length).toBe(1);
  });

  it("passes with only rust-cache", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: Swatinem/rust-cache@v2
      - run: cargo test
`), "double-cache");
    expect(f.length).toBe(0);
  });
});

describe("install-no-cache", () => {
  it("flags npm ci without cache", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`), "install-no-cache");
    expect(f.length).toBe(1);
  });

  it("passes with setup-node cache", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          cache: npm
      - run: npm ci
`), "install-no-cache");
    expect(f.length).toBe(0);
  });

  it("flags bun install with setup-bun (binary cache only)", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: bun install
`), "install-no-cache");
    expect(f.length).toBe(1);
  });

  it("passes bun install with actions/cache for bun deps", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: oven-sh/setup-bun@v2
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-\${{ hashFiles('bun.lock') }}
          restore-keys: bun-
      - run: bun install
`), "install-no-cache");
    expect(f.length).toBe(0);
  });
});

describe("unneeded-full-checkout", () => {
  it("flags fetch-depth 0 with no history use", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm test
`), "unneeded-full-checkout");
    expect(f.length).toBe(1);
  });

  it("passes with git describe usage", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: git describe --tags
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });

  it("passes with release-please action", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: GoogleCloudPlatform/release-please-action@v4
`), "unneeded-full-checkout");
    expect(f.length).toBe(0);
  });
});

describe("macos-not-needed", () => {
  it("flags macos runner with no macos work", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: npm test
`), "macos-not-needed");
    expect(f.length).toBe(1);
  });

  it("passes with xcodebuild", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: xcodebuild -scheme MyApp test
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });

  it("passes with brew", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: brew install something
`), "macos-not-needed");
    expect(f.length).toBe(0);
  });
});

describe("false-serialization", () => {
  it("flags unused dependency", () => {
    const f = findByRule(check(`
name: T
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

  it("passes when using outputs", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      version: \${{ steps.ver.outputs.version }}
    steps:
      - run: echo hi
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - run: echo \${{ needs.build.outputs.version }}
`), "false-serialization");
    expect(f.length).toBe(0);
  });

  it("passes for gate jobs", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm run lint
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [lint]
    steps:
      - run: npm run deploy
`), "false-serialization");
    expect(f.length).toBe(0);
  });
});

describe("repeated-setup", () => {
  it("flags 3+ jobs with same setup", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm run build
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm run build
      - run: npm run lint
  typecheck:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm run build
      - run: npm run typecheck
`), "repeated-setup");
    expect(f.length).toBe(1);
  });

  it("passes with only 2 jobs", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm run build
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm run build
`), "repeated-setup");
    expect(f.length).toBe(0);
  });
});

describe("no-path-filter (pedantic)", () => {
  it("flags workflow without paths when others have them", () => {
    const other = parseWorkflow("other.yml", `
name: Other
on:
  push:
    paths: [src/**]
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`)!;

    const target = parseWorkflow("test.yml", `
name: T
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`)!;

    const findings = runRules(allRules, [target, other], {
      audit: false,
      pedantic: true,
    }).filter((f) => f.rule === "no-path-filter" && f.workflow === "test.yml");
    expect(findings.length).toBe(1);
  });

  it("is not reported without --pedantic", () => {
    const other = parseWorkflow("other.yml", `
name: Other
on:
  push:
    paths: [src/**]
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`)!;

    const target = parseWorkflow("test.yml", `
name: T
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: echo hi
`)!;

    const findings = runRules(allRules, [target, other], {
      audit: false,
      pedantic: false,
    }).filter((f) => f.rule === "no-path-filter");
    expect(findings.length).toBe(0);
  });
});

describe("matrix-max-parallel (pedantic)", () => {
  it("flags max-parallel without deploy step", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      matrix:
        node: [16, 18, 20]
      max-parallel: 2
    steps:
      - run: npm test
`, { pedantic: true }), "matrix-max-parallel");
    expect(f.length).toBe(1);
  });

  it("passes with deploy step", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      matrix:
        env: [staging, prod]
      max-parallel: 1
    steps:
      - run: npm run deploy
`, { pedantic: true }), "matrix-max-parallel");
    expect(f.length).toBe(0);
  });
});

describe("unpinned-action", () => {
  it("flags action on @main", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@main
`), "unpinned-action");
    expect(f.length).toBe(1);
  });

  it("flags action with no ref", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: some/action
`), "unpinned-action");
    expect(f.length).toBe(1);
  });

  it("passes with version tag", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
`), "unpinned-action");
    expect(f.length).toBe(0);
  });

  it("passes with SHA pin", () => {
    const f = findByRule(check(`
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@abcdef1234567890abcdef1234567890abcdef12
`), "unpinned-action");
    expect(f.length).toBe(0);
  });
});
