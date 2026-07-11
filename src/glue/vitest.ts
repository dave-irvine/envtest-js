import { TestEnvironment, type EnvtestConfig, type TestEnvironmentOptions } from "../testenv.js";
// Type-only (elided at runtime): loads vitest's declarations so the
// ProvidedContext augmentation below has a module to attach to, even in a
// src-only compilation. vitest is an optional peer dependency.
import type {} from "vitest";

/**
 * Vitest glue: one shared control plane per test run, started in a
 * globalSetup file and handed to test workers via provide/inject.
 *
 * ```ts
 * // envtest.global.ts (registered as test.globalSetup in vitest config)
 * import { createVitestGlobalSetup } from "@pixelbitsltd/envtest-js/vitest";
 * export default createVitestGlobalSetup({ crdDirectoryPaths: ["./config/crd"] });
 *
 * // some.test.ts
 * import { inject } from "vitest";
 * import type {} from "@pixelbitsltd/envtest-js/vitest"; // types the "envtest" inject key
 * const config = inject("envtest");
 * ```
 *
 * globalSetup runs in a separate process from test workers, so workers get
 * the JSON-serializable EnvtestConfig, not the TestEnvironment instance —
 * use the standalone helpers (installCRDs, waitForWebhookServer, restRequest)
 * with it.
 */
declare module "vitest" {
  export interface ProvidedContext {
    envtest: EnvtestConfig;
  }
}

/** Structural subset of vitest's TestProject — avoids a hard type dependency. */
interface GlobalSetupProject {
  provide(key: "envtest", value: EnvtestConfig): void;
}

export function createVitestGlobalSetup(options: TestEnvironmentOptions = {}) {
  return async function setup(project: GlobalSetupProject): Promise<() => Promise<void>> {
    const env = new TestEnvironment(options);
    const config = await env.start();
    project.provide("envtest", config);
    return async () => {
      await env.stop();
    };
  };
}
