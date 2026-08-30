install:
    bun install

build:
    bun run build

test:
    bun test

lint:
    bun run lint

check: install lint test build

run *ARGS:
    bun run src/cli.ts {{ARGS}}

audit *ARGS:
    bun run src/cli.ts --audit {{ARGS}}

eval:
    bun run src/eval.ts

eval-score *ARGS:
    bun run src/eval-score.ts {{ARGS}}
