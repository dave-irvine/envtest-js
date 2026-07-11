import path from "node:path";
import { fileURLToPath } from "node:url";

import { createVitestGlobalSetup } from "../src/glue/vitest.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export default createVitestGlobalSetup({
  // This suite drives the spawned control plane's binaries and webhooks, so
  // an inherited USE_EXISTING_CLUSTER must never redirect it at a real
  // cluster (attach mode has no config.binaries and would mutate that
  // cluster with our fixtures).
  useExistingCluster: false,
  // Same convention as kubebuilder Makefiles; CI's version-matrix job uses
  // this to run the suite against older control-plane versions.
  version: process.env.ENVTEST_K8S_VERSION,
  crdDirectoryPaths: [
    path.join(FIXTURES, "crontab-crd.yaml"),
    path.join(FIXTURES, "widget-conversion-crd.yaml"),
  ],
  webhookInstallOptions: { paths: [path.join(FIXTURES, "deny-webhook.yaml")] },
});
