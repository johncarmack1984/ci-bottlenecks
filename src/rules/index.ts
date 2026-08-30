import type { Rule } from "../types.ts";

import { noTimeout } from "./no-timeout.ts";
import { doubleTrigger } from "./double-trigger.ts";
import { noConcurrency } from "./no-concurrency.ts";
import { cacheKeyNoHash } from "./cache-key-no-hash.ts";
import { doubleCache } from "./double-cache.ts";
import { installNoCache } from "./install-no-cache.ts";
import { unneededFullCheckout } from "./unneeded-full-checkout.ts";
import { macosNotNeeded } from "./macos-not-needed.ts";
import { falseSerialization } from "./false-serialization.ts";
import { repeatedSetup } from "./repeated-setup.ts";
import { noPathFilter } from "./no-path-filter.ts";
import { matrixMaxParallel } from "./matrix-max-parallel.ts";
import { unpinnedAction } from "./unpinned-action.ts";
import { criticalPath } from "./critical-path.ts";
import { flakyOrHanging } from "./flaky-or-hanging.ts";
import { queueDominated } from "./queue-dominated.ts";
import { setupDominated } from "./setup-dominated.ts";
import { doubleRunMeasured } from "./double-run-measured.ts";

export const allRules: Rule[] = [
  noTimeout,
  doubleTrigger,
  noConcurrency,
  cacheKeyNoHash,
  doubleCache,
  installNoCache,
  unneededFullCheckout,
  macosNotNeeded,
  falseSerialization,
  repeatedSetup,
  noPathFilter,
  matrixMaxParallel,
  unpinnedAction,
  criticalPath,
  flakyOrHanging,
  queueDominated,
  setupDominated,
  doubleRunMeasured,
];
