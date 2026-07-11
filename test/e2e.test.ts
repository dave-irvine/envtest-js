import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withEnv } from "./helpers/env.js";
import { getEnvtestConfig } from "./helpers/envtest.js";
import {
  installCRDs,
  restRequest,
  restRequestOk,
  TestEnvironment,
  uninstallCRDs,
  waitForWebhookServer,
  type EnvtestConfig,
  type RestConfig,
} from "../src/index.js";
import { getFreePort } from "../src/controlplane/ports.js";
import {
  DENY_MESSAGE,
  startTestWebhookServer,
  type TestWebhookServer,
} from "./helpers/webhook-server.js";

const execFileP = promisify(execFile);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Deletion is asynchronous: poll until the object is gone, like upstream's Eventually. */
async function waitForGone(
  config: RestConfig,
  apiPath: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let status: number;
  do {
    status = (await restRequest(config, "GET", apiPath)).status;
    if (status !== 404) await new Promise((r) => setTimeout(r, 100));
  } while (status !== 404 && Date.now() < deadline);
  return status;
}

// The control plane itself is started once for the whole run by our own
// glue, which this suite dogfoods: test/e2e-global-setup.ts under vitest,
// test/bun-preload.ts under bun:test. Binaries download on first run
// (~30MB, cached afterwards).
describe("e2e: real control plane", () => {
  let config: EnvtestConfig;
  let kubectl: string;
  let webhookServer: TestWebhookServer;

  beforeAll(async () => {
    config = await getEnvtestConfig();
    kubectl = config.binaries!.kubectl; // the shared env owns its control plane
    webhookServer = await startTestWebhookServer(config);
    // Warm kubectl's first execution here, where the timeout is generous:
    // on Windows, Defender scans a binary the first time it runs (seconds on
    // CI runners). etcd/kube-apiserver were already executed (and scanned)
    // by the control-plane boot in global setup; kubectl would otherwise pay
    // its scan inside whichever test happens to call it first.
    await execFileP(kubectl, ["version", "--client"]);
  }, 60_000);

  afterAll(async () => {
    await webhookServer?.close();
  }, 60_000);

  it("reports ready and identifies the client via its cert (system:masters)", async () => {
    const version = await restRequestOk(config, "GET", "/version");
    expect(version.json.gitVersion).toMatch(/^v\d+\.\d+\./);

    // SelfSubjectReview reflects back who the apiserver thinks we are —
    // proves client-cert auth (CN -> user, O -> group) actually worked.
    const whoami = await restRequestOk(
      config,
      "POST",
      "/apis/authentication.k8s.io/v1/selfsubjectreviews",
      { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
    );
    expect(whoami.json.status.userInfo.username).toBe("envtest-admin");
    expect(whoami.json.status.userInfo.groups).toContain("system:masters");
  });

  it("performs CRUD against core resources", async () => {
    const create = await restRequestOk(config, "POST", "/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "envtest-e2e" },
    });
    expect(create.status).toBe(201);

    const cm = await restRequestOk(config, "POST", "/api/v1/namespaces/envtest-e2e/configmaps", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "hello" },
      data: { greeting: "world" },
    });
    expect(cm.json.data.greeting).toBe("world");

    const got = await restRequestOk(
      config,
      "GET",
      "/api/v1/namespaces/envtest-e2e/configmaps/hello",
    );
    expect(got.json.metadata.uid).toBe(cm.json.metadata.uid);
  });

  it("installed the CRD and serves custom resources", async () => {
    expect(config.installedCRDs).toContain("crontabs.stable.example.com");

    const cr = await restRequestOk(
      config,
      "POST",
      "/apis/stable.example.com/v1/namespaces/envtest-e2e/crontabs",
      {
        apiVersion: "stable.example.com/v1",
        kind: "CronTab",
        metadata: { name: "my-cron" },
        spec: { cronSpec: "*/5 * * * *", image: "my-image", replicas: 2 },
      },
    );
    expect(cr.status).toBe(201);

    const list = await restRequestOk(
      config,
      "GET",
      "/apis/stable.example.com/v1/namespaces/envtest-e2e/crontabs",
    );
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0].spec.cronSpec).toBe("*/5 * * * *");
  });

  it("re-installing the same CRD is idempotent", async () => {
    const names = await installCRDs(config, [path.join(FIXTURES, "crontab-crd.yaml")]);
    expect(names).toEqual(["crontabs.stable.example.com"]);
  });

  // Upstream: "should install the CRDs into the cluster using directory" and
  // implicitly that non-CRD manifests in the directory are filtered out
  // (fixtures/ also contains the webhook configuration).
  it("installs CRDs from a directory, ignoring non-CRD manifests", async () => {
    const webhook = config.webhook!;
    const names = await installCRDs(config, [FIXTURES], {
      conversionWebhook: { host: webhook.host, port: webhook.port, caPem: webhook.caPem },
    });
    expect(names.sort()).toEqual([
      "crontabs.stable.example.com",
      "widgets.conversion.example.com",
    ]);
  });

  // Upstream: "should not return an error if the directory doesn't exist"
  // (there the silent skip is the default; here it's opt-in via
  // errorIfPathMissing: false — our default is to throw, see crd.test.ts).
  it("skips missing paths when errorIfPathMissing is disabled", async () => {
    const names = await installCRDs(
      config,
      [path.join(FIXTURES, "does-not-exist"), path.join(FIXTURES, "crontab-crd.yaml")],
      { errorIfPathMissing: false },
    );
    expect(names).toEqual(["crontabs.stable.example.com"]);
  });

  // Upstream: CRDInstallOptions.PollInterval — the Established wait honors a
  // configured poll interval instead of the fixed default.
  it("waits for Established at a configured poll interval", async () => {
    const names = await installCRDs(config, [path.join(FIXTURES, "crontab-crd.yaml")], {
      pollIntervalMs: 10,
    });
    expect(names).toEqual(["crontabs.stable.example.com"]);
  });

  // Upstream: CRDInstallOptions.CRDs — in-memory definitions install
  // alongside (before) those rendered from paths, and can be uninstalled
  // the same way.
  it("installs and uninstalls in-memory CRD manifests alongside paths", async () => {
    const memoCRD = {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: "memos.inmemory.example.com" },
      spec: {
        group: "inmemory.example.com",
        names: { kind: "Memo", listKind: "MemoList", plural: "memos", singular: "memo" },
        scope: "Namespaced",
        versions: [
          {
            name: "v1",
            served: true,
            storage: true,
            schema: {
              openAPIV3Schema: {
                type: "object",
                properties: { spec: { type: "object", properties: { text: { type: "string" } } } },
              },
            },
          },
        ],
      },
    };
    const before = JSON.stringify(memoCRD);

    const names = await installCRDs(config, [path.join(FIXTURES, "crontab-crd.yaml")], {
      crds: [memoCRD],
    });
    expect(names).toEqual(["memos.inmemory.example.com", "crontabs.stable.example.com"]);

    // The CRD is served: create a custom resource against it, exercising the
    // in-memory schema (unknown fields would be pruned; text survives).
    const cr = await restRequestOk(
      config,
      "POST",
      "/apis/inmemory.example.com/v1/namespaces/envtest-e2e/memos",
      {
        apiVersion: "inmemory.example.com/v1",
        kind: "Memo",
        metadata: { name: "m1" },
        spec: { text: "from memory" },
      },
    );
    expect(cr.json.spec.text).toBe("from memory");

    // The caller's object is applied, not adopted: no mutation.
    expect(JSON.stringify(memoCRD)).toBe(before);

    expect(await uninstallCRDs(config, [], { crds: [memoCRD] })).toEqual([
      "memos.inmemory.example.com",
    ]);
  });

  // Upstream: "should uninstall the CRDs from the cluster". Uses its own
  // fixture (in a subdirectory, invisible to directory-based installs of
  // fixtures/) so shared CRDs other tests rely on stay untouched.
  it("uninstalls CRDs from the cluster", async () => {
    const gadgetCRD = path.join(FIXTURES, "uninstall", "gadget-crd.yaml");
    const installed = await installCRDs(config, [gadgetCRD]);
    expect(installed).toEqual(["gadgets.uninstall.example.com"]);

    const deleted = await uninstallCRDs(config, [gadgetCRD]);
    expect(deleted).toEqual(["gadgets.uninstall.example.com"]);

    const crdPath =
      "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/gadgets.uninstall.example.com";
    expect(await waitForGone(config, crdPath)).toBe(404);

    // Uninstalling already-absent CRDs is a no-op, like upstream
    // (IsNotFound errors are ignored).
    expect(await uninstallCRDs(config, [gadgetCRD])).toEqual([]);
  });

  it("writes a kubeconfig that the real kubectl accepts", async () => {
    const { stdout } = await execFileP(kubectl, [
      "--kubeconfig",
      config.kubeconfigPath,
      "get",
      "crontabs",
      "-n",
      "envtest-e2e",
      "-o",
      "json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].metadata.name).toBe("my-cron");
  });

  // Upstream Stop() returns before ControlPlane.Stop() when using an
  // existing cluster (server.go) — an attached environment installs into
  // the shared cluster, and stopping it must NOT tear that cluster down.
  // Runs under Bun too: the attached env dials the same cluster with the
  // same CA, so the process-wide TLS trust cache is a non-issue.
  it("attaches to the running cluster via kubeconfig; stop() leaves it running", async () => {
    const attachCRD = {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: "attachments.existing.example.com" },
      spec: {
        group: "existing.example.com",
        names: {
          kind: "Attachment",
          listKind: "AttachmentList",
          plural: "attachments",
          singular: "attachment",
        },
        scope: "Namespaced",
        versions: [
          {
            name: "v1",
            served: true,
            storage: true,
            schema: { openAPIV3Schema: { type: "object" } },
          },
        ],
      },
    };
    const crdPath =
      "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/attachments.existing.example.com";

    const webhookPath =
      "/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations/envtest-attach-cleanup";
    const env = new TestEnvironment({
      useExistingCluster: true,
      crds: [attachCRD],
      // Leave the shared cluster as we found it: CRD cleanup is upstream
      // parity (CRDInstallOptions.CleanUpAfterUse); webhook-configuration
      // cleanup is our extension — upstream would leave the configuration
      // pointing at this dead test process.
      crdInstallOptions: { cleanUpAfterUse: true },
      webhookInstallOptions: {
        paths: [path.join(FIXTURES, "attach", "cleanup-webhook.yaml")],
        cleanUpAfterUse: true,
      },
    });
    try {
      const attached = await withEnv({ KUBECONFIG: config.kubeconfigPath }, () => env.start());
      expect(attached.server).toBe(config.server);
      expect(attached.user).toBe("envtest-admin");
      expect(attached.binaries).toBeUndefined();
      expect(attached.etcdURL).toBeUndefined();
      expect(attached.installedCRDs).toEqual(["attachments.existing.example.com"]);
      expect(attached.webhook!.configurationNames).toEqual(["envtest-attach-cleanup"]);

      // The webhook configuration landed on the shared cluster too.
      const hook = await restRequestOk(config, "GET", webhookPath);
      expect(hook.json.metadata.name).toBe("envtest-attach-cleanup");

      // The parsed credentials authenticate as the kubeconfig's identity.
      const whoami = await restRequestOk(
        attached,
        "POST",
        "/apis/authentication.k8s.io/v1/selfsubjectreviews",
        { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
      );
      expect(whoami.json.status.userInfo.username).toBe("envtest-admin");

      // The CRD landed on the SAME cluster, visible through the original config.
      const seen = await restRequestOk(config, "GET", crdPath);
      expect(seen.json.metadata.name).toBe("attachments.existing.example.com");
    } finally {
      await env.stop();
    }

    // The shared control plane survived the attached environment's stop().
    const version = await restRequestOk(config, "GET", "/version");
    expect(version.json.gitVersion).toMatch(/^v\d+\.\d+\./);

    // cleanUpAfterUse removed both installs from the shared cluster during
    // stop(), while it could still reach the apiserver.
    expect(await waitForGone(config, crdPath)).toBe(404);
    expect(await waitForGone(config, webhookPath)).toBe(404);
  });

  // stop()'s cleanUpAfterUse pass is driven by the started config, which a
  // failed start() never produces — rollback must cover that window, or a
  // partial start leaks webhook configurations into the shared cluster.
  it("rolls back cleanUpAfterUse installs when start() fails partway", async () => {
    const webhookPath =
      "/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations/envtest-attach-cleanup";
    const env = new TestEnvironment({
      useExistingCluster: true,
      // Webhooks install first (as upstream orders it), then the CRD read
      // fails: without rollback the configuration would be orphaned.
      crdDirectoryPaths: [path.join(FIXTURES, "attach", "does-not-exist.yaml")],
      crdInstallOptions: { cleanUpAfterUse: true },
      webhookInstallOptions: {
        paths: [path.join(FIXTURES, "attach", "cleanup-webhook.yaml")],
        cleanUpAfterUse: true,
      },
    });
    await withEnv({ KUBECONFIG: config.kubeconfigPath }, () =>
      expect(env.start()).rejects.toThrow(/does-not-exist/),
    );
    expect(await waitForGone(config, webhookPath)).toBe(404);
  });

  // Node-only: this validates the official client against our kubeconfig;
  // client-node's own Bun support is its project's contract, not ours.
  // Lazily imported so Bun never loads the module at all.
  if (!process.versions.bun) {
    it("interops with the official @kubernetes/client-node", async () => {
      const { CoreV1Api, CustomObjectsApi, KubeConfig } = await import("@kubernetes/client-node");
      const kc = new KubeConfig();
      kc.loadFromString(config.kubeconfigYaml);

      const core = kc.makeApiClient(CoreV1Api);
      const namespaces = await core.listNamespace();
      expect(namespaces.items.map((ns) => ns.metadata?.name)).toContain("envtest-e2e");

      const created = await core.createNamespace({
        body: { metadata: { name: "client-node-interop" } },
      });
      expect(created.metadata?.name).toBe("client-node-interop");

      const custom = kc.makeApiClient(CustomObjectsApi);
      const crontabs = (await custom.listNamespacedCustomObject({
        group: "stable.example.com",
        version: "v1",
        namespace: "envtest-e2e",
        plural: "crontabs",
      })) as { items: Array<{ metadata: { name: string } }> };
      expect(crontabs.items.map((c) => c.metadata.name)).toContain("my-cron");
    });
  }

  it("enforces a validating webhook served from the test process", async () => {
    expect(config.webhook!.configurationNames).toEqual(["envtest-deny-labeled"]);
    await waitForWebhookServer(config.webhook!.host, config.webhook!.port, { caPem: config.webhook!.caPem });

    // A labeled ConfigMap matches the objectSelector -> apiserver calls our
    // server over HTTPS (trusting the injected caBundle) -> denied.
    const denied = await restRequest(config, "POST", "/api/v1/namespaces/envtest-e2e/configmaps", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "should-be-denied", labels: { "envtest-webhook": "deny" } },
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.json?.message).toContain(DENY_MESSAGE);
    expect(webhookServer.calls).toContain("/validate-deny"); // service.path survived the rewrite

    // An unlabeled ConfigMap doesn't match the selector -> allowed.
    const allowed = await restRequestOk(config, "POST", "/api/v1/namespaces/envtest-e2e/configmaps", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "not-labeled-so-allowed" },
    });
    expect(allowed.status).toBe(201);
  });

  it("routes CRD version conversion through the in-process webhook", async () => {
    expect(config.installedCRDs).toContain("widgets.conversion.example.com");
    await waitForWebhookServer(config.webhook!.host, config.webhook!.port, { caPem: config.webhook!.caPem });

    // Stored at v1 (storage version): no conversion involved.
    await restRequestOk(config, "POST", "/apis/conversion.example.com/v1/namespaces/envtest-e2e/widgets", {
      apiVersion: "conversion.example.com/v1",
      kind: "Widget",
      metadata: { name: "w1" },
      spec: { size: "large" },
    });

    // Reading at v2 forces the apiserver to convert v1 -> v2 via our webhook.
    const v2 = await restRequestOk(
      config,
      "GET",
      "/apis/conversion.example.com/v2/namespaces/envtest-e2e/widgets/w1",
    );
    expect(v2.json.apiVersion).toBe("conversion.example.com/v2");
    expect(v2.json.spec.size).toBe("large");
    expect(webhookServer.calls).toContain("/convert"); // service.path survived the rewrite
  });

  // Bun-only: only the bun:test glue shares a process with the live
  // TestEnvironment (vitest workers get the serialized config across the
  // globalSetup process boundary — fresh-env coverage for Node is below).
  // Identity is verified through kubectl: a separate process, so Bun's
  // process-wide TLS trust cache can't hand it the admin's socket.
  if (process.versions.bun) {
    it("addUser provisions an identity kubectl can use against the shared env", async () => {
      const { envtest } = await import("../src/glue/bun.js");
      const user = await envtest().addUser({ name: "bun-user", groups: ["bun-group"] });

      const { stdout } = await execFileP(kubectl, [
        "--kubeconfig",
        user.kubeconfigPath,
        "auth",
        "whoami",
        "-o",
        "json",
      ]);
      const userInfo = JSON.parse(stdout).status.userInfo;
      expect(userInfo.username).toBe("bun-user");
      expect(userInfo.groups).toContain("bun-group");
    });
  }

  // Node-only: Bun pools TLS connections without keying on client
  // credentials (and ignores `agent` options), so this certless request
  // silently reuses the authenticated socket from earlier tests and gets
  // 200. What it verifies — the apiserver denying anonymous clients — is
  // server-side behavior, so Node coverage proves it for both runtimes.
  if (!process.versions.bun) {
    it("rejects clients that do not present a trusted client cert", async () => {
      // Same CA bundle, but no client cert: apiserver should treat us as
      // system:anonymous and RBAC should deny.
      const res = await restRequest(
        { ...config, certPem: "", keyPem: "" },
        "GET",
        "/api/v1/namespaces",
      ).catch((err: Error) => err);
      if (res instanceof Error) {
        // TLS-level rejection is also acceptable.
        expect(res).toBeInstanceOf(Error);
      } else {
        expect([401, 403]).toContain(res.status);
      }
    });
  }
});

// Node-only + not macOS. This test boots a SECOND environment, and Bun
// caches the TLS trust context of the first mTLS request process-wide
// (node:https, node:http, and native fetch all sit behind that cache), so a
// second environment's CA can never be trusted in the same Bun process —
// verified down to raw tls.connect, which is the only layer that honors
// per-connection options. One environment per Bun process (the recommended
// shared-env pattern) is unaffected. macOS lacks 127.0.0.2 as a loopback
// alias out of the box.
if (!process.versions.bun && process.platform !== "darwin") {
  describe("custom listenAddress", () => {
    it("binds, certs, and addresses the kubeconfig consistently, on the requested port", async () => {
      // Upstream apiserver_test: "when SecureServing host & port are set —
      // should leave SecureServing as-is".
      const requestedPort = await getFreePort("127.0.0.2");
      const env = new TestEnvironment({
        version: process.env.ENVTEST_K8S_VERSION,
        listenAddress: "127.0.0.2",
        securePort: requestedPort,
      });
      const config = await env.start();
      try {
        // The three plumbing points must agree: bind-address (the server
        // answers there), the kubeconfig/server URL (clients dial it), and
        // the serving-cert SANs — node's TLS stack verifies the hostname
        // against the cert on this request, so a missing SAN fails here.
        expect(config.server).toBe(`https://127.0.0.2:${requestedPort}`);
        expect(config.apiServerPort).toBe(requestedPort);
        const version = await restRequestOk(config, "GET", "/version");
        expect(version.json.gitVersion).toMatch(/^v\d+\.\d+\./);
      } finally {
        await env.stop();
      }
    }, 120_000);
  });
}

// Node-only: needs the live TestEnvironment instance, which under vitest
// means booting a fresh one here — and a second in-process environment's CA
// is exactly what Bun's cached TLS trust context cannot verify (see the
// custom listenAddress note). Bun coverage runs against the shared env above.
if (!process.versions.bun) {
  describe("addUser", () => {
    // Upstream envtest_test: "should provision a new user that behaves
    // when the flow is correct" (plane.AddUser / CertAuthn).
    it("provisions users with their own certs, REST config, and kubeconfig", async () => {
      const env = new TestEnvironment({ version: process.env.ENVTEST_K8S_VERSION });
      await expect(env.addUser({ name: "too-early" })).rejects.toThrow("not started");

      const config = await env.start();
      try {
        const user = await env.addUser({ name: "jane", groups: ["group1", "group2"] });
        expect(user.user).toBe("jane");
        expect(user.server).toBe(config.server);
        expect(user.certPem).not.toBe(config.certPem);

        // Upstream auth_test: CertData/KeyData are populated; ours must also
        // round-trip to the PEMs (they're the kubeconfig field encoding).
        expect(Buffer.from(user.certData, "base64").toString()).toBe(user.certPem);
        expect(Buffer.from(user.keyData, "base64").toString()).toBe(user.keyPem);

        // The apiserver authenticates the new cert and maps CN -> user,
        // O -> groups.
        const whoami = await restRequestOk(
          user,
          "POST",
          "/apis/authentication.k8s.io/v1/selfsubjectreviews",
          { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
        );
        const userInfo = whoami.json.status.userInfo;
        expect(userInfo.username).toBe("jane");
        expect(userInfo.groups).toEqual(
          expect.arrayContaining(["group1", "group2", "system:authenticated"]),
        );

        // Not an admin: RBAC denies what system:masters may do.
        const denied = await restRequest(user, "GET", "/api/v1/namespaces");
        expect(denied.status).toBe(403);

        // The written kubeconfig is kubectl-ready.
        const { stdout } = await execFileP(config.binaries!.kubectl, [
          "--kubeconfig",
          user.kubeconfigPath,
          "auth",
          "whoami",
          "-o",
          "json",
        ]);
        expect(JSON.parse(stdout).status.userInfo.username).toBe("jane");

        // Names that sanitize to the same filename get distinct files.
        const colon = await env.addUser({ name: "system:weird" });
        const slash = await env.addUser({ name: "system/weird" });
        expect(colon.kubeconfigPath).not.toBe(slash.kubeconfigPath);

        // Upstream auth_test: "should copy the configuration ... without
        // modifying it" — caller input is copied, not adopted: mutating the
        // groups array afterwards must not change the provisioned user.
        const groups = ["before"];
        const copied = await env.addUser({ name: "copy-check", groups });
        groups.push("after");
        expect(copied.groups).toEqual(["before"]);
      } finally {
        await env.stop();
      }
    }, 120_000);
  });

  describe("environment lifecycle", () => {
    // Upstream plane_test: "should be able to restart".
    it("can be restarted: stop() then start() on the same instance", async () => {
      const restartCRD = {
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        metadata: { name: "rounds.restart.example.com" },
        spec: {
          group: "restart.example.com",
          names: { kind: "Round", listKind: "RoundList", plural: "rounds", singular: "round" },
          scope: "Namespaced",
          versions: [
            {
              name: "v1",
              served: true,
              storage: true,
              schema: { openAPIV3Schema: { type: "object" } },
            },
          ],
        },
      };
      // cleanUpAfterUse also runs in owned mode (upstream parity): stop()
      // uninstalls against the live apiserver BEFORE tearing it down — if
      // that ordering regressed, the delete calls would fail and stop()
      // itself would reject, failing this test on both cycles.
      const env = new TestEnvironment({
        version: process.env.ENVTEST_K8S_VERSION,
        crds: [restartCRD],
        crdInstallOptions: { cleanUpAfterUse: true },
      });
      const first = await env.start();
      expect(first.installedCRDs).toEqual(["rounds.restart.example.com"]);
      await restRequestOk(first, "GET", "/version");
      await env.stop();

      const second = await env.start();
      try {
        const version = await restRequestOk(second, "GET", "/version");
        expect(version.json.gitVersion).toMatch(/^v\d+\.\d+\./);
        // A restart is a fresh environment: new CA, new state.
        expect(second.caPem).not.toBe(first.caPem);
      } finally {
        await env.stop();
      }
    }, 120_000);
  });
}
