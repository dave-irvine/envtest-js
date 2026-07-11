/**
 * ONE set of test files runs under both runtimes: `vitest` on Node,
 * `bun:test` under Bun. The test files import describe/it/expect straight
 * from "vitest" — `bun test` remaps "vitest" imports to `bun:test`
 * (jest-compatible surface), so no runner shim is needed. The only genuinely
 * runner-specific seam is how tests reach the shared control plane's config,
 * which this helper hides.
 */
import type { EnvtestConfig } from "../../src/index.js";
import type {} from "../../src/glue/vitest.js"; // types the "envtest" inject key

/**
 * The shared control plane's config, whichever runner booted it:
 * vitest provides it from the globalSetup process via inject; under Bun the
 * preload script registered the environment in-process.
 */
export async function getEnvtestConfig(): Promise<EnvtestConfig> {
  if (process.versions.bun) {
    const { envtestConfig } = await import("../../src/glue/bun.js");
    return envtestConfig();
  }
  const { inject } = await import("vitest");
  return inject("envtest");
}
