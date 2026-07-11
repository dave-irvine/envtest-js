// bun:test preload (registered in bunfig.toml): one shared control plane for
// the whole `bun test` run, via the envtest-js/bun glue. The Node/vitest
// equivalent is test/e2e-global-setup.ts — keep their options in sync.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "bun:test";

import { registerEnvtest } from "../src/glue/bun.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

registerEnvtest(
  { beforeAll, afterAll },
  {
    // See test/e2e-global-setup.ts: never let an inherited
    // USE_EXISTING_CLUSTER point this suite at a real cluster.
    useExistingCluster: false,
    version: process.env.ENVTEST_K8S_VERSION,
    crdDirectoryPaths: [
      path.join(FIXTURES, "crontab-crd.yaml"),
      path.join(FIXTURES, "widget-conversion-crd.yaml"),
    ],
    webhookInstallOptions: { paths: [path.join(FIXTURES, "deny-webhook.yaml")] },
  },
);
