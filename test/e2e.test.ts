import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  getEnvtestConfig,
  it,
} from "./helpers/runner.js";
import {
  installCRDs,
  restRequest,
  restRequestOk,
  TestEnvironment,
  uninstallCRDs,
  waitForWebhookServer,
  type EnvtestConfig,
} from "../src/index.js";
import { getFreePort } from "../src/controlplane/ports.js";
import {
  DENY_MESSAGE,
  startTestWebhookServer,
  type TestWebhookServer,
} from "./helpers/webhook-server.js";

const execFileP = promisify(execFile);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// The control plane itself is started once for the whole run by our own
// glue, which this suite dogfoods: test/e2e-global-setup.ts under vitest,
// test/bun-preload.ts under bun:test. Binaries download on first run
// (~30MB, cached afterwards).
describe("e2e: real control plane", () => {
  let config: EnvtestConfig;
  let webhookServer: TestWebhookServer;

  beforeAll(async () => {
    config = await getEnvtestConfig();
    webhookServer = await startTestWebhookServer(config);
    // Warm kubectl's first execution here, where the timeout is generous:
    // on Windows, Defender scans a binary the first time it runs (seconds on
    // CI runners). etcd/kube-apiserver were already executed (and scanned)
    // by the control-plane boot in global setup; kubectl would otherwise pay
    // its scan inside whichever test happens to call it first.
    await execFileP(config.binaries.kubectl, ["version", "--client"]);
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

  // Upstream: "should uninstall the CRDs from the cluster". Uses its own
  // fixture (in a subdirectory, invisible to directory-based installs of
  // fixtures/) so shared CRDs other tests rely on stay untouched.
  it("uninstalls CRDs from the cluster", async () => {
    const gadgetCRD = path.join(FIXTURES, "uninstall", "gadget-crd.yaml");
    const installed = await installCRDs(config, [gadgetCRD]);
    expect(installed).toEqual(["gadgets.uninstall.example.com"]);

    const deleted = await uninstallCRDs(config, [gadgetCRD]);
    expect(deleted).toEqual(["gadgets.uninstall.example.com"]);

    // Deletion is asynchronous: poll until the CRD is gone, as upstream's
    // test does with Eventually.
    const crdPath =
      "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/gadgets.uninstall.example.com";
    const deadline = Date.now() + 10_000;
    let status;
    do {
      status = (await restRequest(config, "GET", crdPath)).status;
      if (status !== 404) await new Promise((r) => setTimeout(r, 100));
    } while (status !== 404 && Date.now() < deadline);
    expect(status).toBe(404);

    // Uninstalling already-absent CRDs is a no-op, like upstream
    // (IsNotFound errors are ignored).
    expect(await uninstallCRDs(config, [gadgetCRD])).toEqual([]);
  });

  it("writes a kubeconfig that the real kubectl accepts", async () => {
    const { stdout } = await execFileP(config.binaries.kubectl, [
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

// Node-only: restarting mints a second CA in-process, which Bun's cached
// TLS trust context cannot verify (see the custom listenAddress note).
if (!process.versions.bun) {
  describe("environment lifecycle", () => {
    // Upstream plane_test: "should be able to restart".
    it("can be restarted: stop() then start() on the same instance", async () => {
      const env = new TestEnvironment({ version: process.env.ENVTEST_K8S_VERSION });
      const first = await env.start();
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
