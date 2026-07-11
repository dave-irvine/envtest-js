# envtest-js

Run a **real Kubernetes API server** (`kube-apiserver` + `etcd`) for integration tests, from Node or Bun — a pure-TypeScript port of controller-runtime's [envtest](https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/envtest).

No Docker, no cluster, no Go toolchain. Startup is ~2–5 seconds once binaries are cached.

```ts
import { TestEnvironment, restRequestOk } from "envtest-js";

const env = new TestEnvironment({
  crdDirectoryPaths: ["./config/crd"], // optional: files or directories
});

const config = await env.start();
// config.server            -> https://127.0.0.1:<port>
// config.kubeconfigPath    -> ready-to-use kubeconfig (works with kubectl and @kubernetes/client-node)
// config.caPem / certPem / keyPem (+ base64 caData/certData/keyData)

// Tiny built-in REST client for tests that don't want a client library:
await restRequestOk(config, "POST", "/api/v1/namespaces", {
  apiVersion: "v1", kind: "Namespace", metadata: { name: "test" },
});

await env.stop();
```

With `@kubernetes/client-node`:

```ts
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";

const kc = new KubeConfig();
kc.loadFromFile(config.kubeconfigPath); // or kc.loadFromString(config.kubeconfigYaml)
const core = kc.makeApiClient(CoreV1Api);
```

## Why this exists

If you build Kubernetes operators, controllers, or admission webhooks in TypeScript, your integration-test options used to be two bad extremes.

1. **Mocked clients** don't exercise anything the apiserver actually does — CRD structural-schema validation, RBAC, resourceVersion conflicts, finalizers, watch semantics — and admission/conversion webhooks can't be tested against a mock *at all*, because the real behavior is the apiserver calling back into your handler over TLS it trusts.
2. **Real clusters via Docker** (`@testcontainers/k3s`, kind) validate everything but cost 20–30s startup, require Docker, and aren't cheap enough to be hermetic per suite.

Go teams have had the middle ground for years: [envtest](https://book.kubebuilder.io/reference/envtest.html) — the real `kube-apiserver` + `etcd`, no Docker, throwaway state, seconds to start. But upstream envtest is two layers, only one of which is reusable from Node:

- **The binaries** (`etcd`, `kube-apiserver`, `kubectl`) are language-agnostic, and envtest-js reuses that layer entirely: same release index, same SHA-512 verification, `KUBEBUILDER_ASSETS`/`TEST_ASSET_*` honored with upstream precedence — a CI host set up for Go envtest works unchanged.
- **The orchestration** (throwaway PKI, apiserver flags, readiness, kubeconfig, CRD install, webhook injection) is a **Go library, not a CLI** — there's no `envtest start` to shell out to.

Same deliberate limits as upstream envtest: this is the API surface only — no scheduler or controller-manager, so Pods never actually run, Deployments don't create ReplicaSets, and garbage collection doesn't fire. If you need a complete cluster and have Docker available, `@testcontainers/k3s` is the better tool for that job.

## What it does

1. **Binary acquisition** — fetches the upstream release index (`envtest-releases.yaml` from kubernetes-sigs/controller-tools), downloads the per-OS/arch tarball, verifies its SHA-512, and caches the binaries in the platform data dir (`~/.local/share/envtest-js`, `%LOCALAPPDATA%\envtest-js`, …). Compatible with existing CI setups: `KUBEBUILDER_ASSETS` and `TEST_ASSET_ETCD` / `TEST_ASSET_KUBE_APISERVER` / `TEST_ASSET_KUBECTL` are honored with the same precedence as Go envtest.
2. **Full-fidelity PKI** (no `insecure-skip-tls-verify` anywhere) — a throwaway CA (ECDSA P-256, via [@peculiar/x509](https://github.com/PeculiarVentures/x509) on WebCrypto) signs:
   - the apiserver serving cert (SANs: `localhost`, `127.0.0.1`, `::1`, `kubernetes.default.svc`, …),
   - an admin client cert with `CN=envtest-admin, O=system:masters` — Kubernetes maps CN→username and O→groups, so this is real RBAC-backed client-cert auth;
   - plus an RSA-2048 keypair for genuine service-account token signing (`--service-account-signing-key-file`).
3. **Process lifecycle** — starts etcd on a free port, then kube-apiserver with the same default flag set as upstream envtest (secure serving only, `--authorization-mode=RBAC`, `ServiceAccount` admission disabled), polls `/readyz` over mTLS, and tears down hard on `stop()` (SIGTERM → SIGKILL, temp dirs removed). Processes are spawned via execa with `cleanup` enabled, so children are killed even when the test runner dies from a signal.
4. **Client config** — a self-contained kubeconfig (verified in e2e against real `kubectl` and the official `@kubernetes/client-node`) plus in-memory PEM/base64 credentials.
5. **CRD install** — applies `CustomResourceDefinition` manifests (create-or-replace) and waits for the `Established` condition, like `envtest.InstallCRDs`; `uninstallCRDs` deletes them again (missing ones skipped), like `envtest.UninstallCRDs`.
6. **Webhook support** — runs your admission *and CRD conversion* webhooks *in the test process*, like upstream's `WebhookInstallOptions`: a separate throwaway CA mints a serving cert for your HTTPS server; each `(Validating|Mutating)WebhookConfiguration` gets its `clientConfig` rewritten to `https://127.0.0.1:<port><service.path>` with the CA injected as `caBundle`; CRDs declaring `spec.conversion.strategy: Webhook` get the same treatment (defaulting to controller-runtime's `/convert` path). See below.

## Admission webhooks

```ts
import https from "node:https";

const env = new TestEnvironment({
  webhookInstallOptions: { paths: ["./config/webhook"] },
});
const config = await env.start();

const wh = config.webhook!; // host, port, certPem/keyPem (+ certDir with tls.crt/tls.key)
const server = https.createServer({ cert: wh.certPem, key: wh.keyPem }, admissionHandler);
await new Promise<void>((resolve) => server.listen(wh.port, wh.host, resolve));
await env.waitForWebhookServer(); // dial-check verifying the serving cert against the webhook CA

// ...requests matching your webhook rules now round-trip through your handler.
```

The webhook configurations are installed with `failurePolicy` as authored — with `Fail`, matching requests are rejected until your server is up, exactly as in Go envtest.

**CRD conversion webhooks**: any CRD passed via `crdDirectoryPaths` that declares `spec.conversion.strategy: Webhook` is automatically pointed at the same local serving address (path from the authored `service.path`, defaulting to `/convert`) with the CA bundle injected. Serve `ConversionReview` on that path from the same HTTPS server. Upstream decides convertibility from the Go scheme; with no scheme in JS, the manifest's declared strategy is the trigger.

## Options

```ts
new TestEnvironment({
  version: "1.36",              // exact ("v1.36.2"), semver range ("1.36", ">=1.35 <1.37"), or omit for latest stable
  binaryAssetsDirectory: "...", // skip download, use these binaries
  crdDirectoryPaths: [...],     // CRD manifests to install on start
  apiServerFlags: { "max-requests-inflight": "800", "allow-privileged": null }, // override / remove (null) defaults; arrays repeat the flag
  etcdFlags: { ... },
  listenAddress: "172.17.0.1",  // apiserver bind + serving-cert SAN + kubeconfig URL move together
                                // (e.g. a Docker bridge IP so containers reach the host's apiserver);
                                // default 127.0.0.1. Wildcards (0.0.0.0) bind everything but only
                                // loopback names land in the SANs.
  securePort: 6443,             // fixed apiserver port; default: an OS-assigned free port
  attachOutput: true,           // pipe etcd/apiserver logs to stderr
  startTimeoutMs: 60_000,
})
```

Recommended test-runner pattern (same as upstream): **one control plane per suite**, not per test. Glue for the two main runners ships with the package:

## Security posture

Everything client-facing is verified mTLS: the apiserver serves only HTTPS with a throwaway CA, clients authenticate with certs (no tokens, no `insecure-skip-tls-verify`), webhook callbacks are verified via the injected `caBundle`, and `waitForWebhookServer` verifies the serving cert rather than dial-checking blindly. Private keys and the kubeconfig are written `0600` inside a `0700` temp dir. Two deliberate limits, both inherited from upstream envtest: **etcd listens in plaintext without authentication on loopback** (only the co-located apiserver is meant to talk to it, but any local process *could* — don't run envtest on hosts with untrusted local users), and the apiserver's default `anonymous-auth` stays enabled (RBAC denies anonymous everything beyond health/version discovery, and the health endpoints need it).

## Runtime support

Node ≥ 24 and Bun.

One known Bun limitation: Bun caches the TLS trust context of the first mTLS request **process-wide** (node:https, node:http, and native `fetch` all sit behind that cache; per-request `ca`/`cert`/`key` are ignored afterwards). Since every `TestEnvironment` mints its own throwaway CA, this means **one environment per Bun process** — a second environment's apiserver can never be verified. The recommended pattern (one shared environment per run, via the test-runner glue) is unaffected. On Node, multiple concurrent environments work fine.

## Not yet implemented

- Structured helpers beyond CRDs (e.g. applying arbitrary manifests) — use `restRequest`/`kubectl`/a client library.
