install:
    bun install

build:
    bun build src/action.ts --target=node --outfile dist/index.js

test:
    bun test

lint:
    tsc --noEmit

check: install lint test build

run *ARGS:
    bun run src/cli.ts {{ARGS}}

audit *ARGS:
    bun run src/cli.ts --audit {{ARGS}}

eval:
    bun run src/eval.ts
