import { TestEnvironment, type EnvtestConfig, type TestEnvironmentOptions } from "../testenv.js";

/**
 * bun:test glue: one shared control plane per test run, registered from a
 * preload script (bunfig.toml `[test].preload`).
 *
 * ```ts
 * // preload.ts
 * import { afterAll, beforeAll } from "bun:test";
 * import { registerEnvtest } from "@pixelbitsltd/envtest-js/bun";
 * registerEnvtest({ beforeAll, afterAll }, { crdDirectoryPaths: ["./config/crd"] });
 *
 * // some.test.ts
 * import { envtestConfig } from "@pixelbitsltd/envtest-js/bun";
 * const config = envtestConfig();
 * ```
 *
 * The runner's hooks are passed in rather than imported, so this module has
 * no bun:test dependency — it works with any runner exposing
 * beforeAll/afterAll semantics. Unlike the vitest glue (which crosses a
 * process boundary), preload and test files share one process, so tests can
 * reach the live TestEnvironment via envtest().
 */
export interface TestHooks {
  beforeAll(fn: () => Promise<unknown> | unknown): void;
  afterAll(fn: () => Promise<unknown> | unknown): void;
}

let current: TestEnvironment | undefined;

export function registerEnvtest(hooks: TestHooks, options: TestEnvironmentOptions = {}): void {
  if (current) {
    throw new Error("registerEnvtest was called twice — one shared environment per run");
  }
  const env = new TestEnvironment(options);
  current = env;
  hooks.beforeAll(async () => {
    await env.start();
  });
  hooks.afterAll(async () => {
    try {
      await env.stop();
    } finally {
      current = undefined;
    }
  });
}

/** The shared environment registered by registerEnvtest. */
export function envtest(): TestEnvironment {
  if (!current) {
    throw new Error("no shared environment — call registerEnvtest in a preload script first");
  }
  return current;
}

/** Shortcut for envtest().config (throws before start()/after stop()). */
export function envtestConfig(): EnvtestConfig {
  return envtest().config;
}
