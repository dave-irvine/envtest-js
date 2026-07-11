import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { withEnv } from "./helpers/env.js";
import {
  buildKubeconfig,
  parseKubeconfig,
  TestEnvironment,
  TinyCA,
  type RestConfig,
} from "../src/index.js";

/**
 * Attach-mode behavior that needs no cluster at all: with no CRDs or
 * webhooks to install, start() only resolves credentials and writes a
 * kubeconfig, so everything here runs offline. The pre-existing-cluster
 * round-trip against a live apiserver lives in e2e.test.ts.
 */
describe("useExistingCluster (offline)", () => {
  let restConfig: RestConfig;

  beforeAll(async () => {
    const ca = await TinyCA.create();
    const client = await ca.newClientCert("unit-user", ["unit-group"]);
    restConfig = {
      server: "https://127.0.0.1:6443",
      caPem: ca.certificatePem,
      certPem: client.certPem,
      keyPem: client.keyPem,
    };
  });

  it("attaches with an explicit config: no control plane, identity from the cert CN", async () => {
    const env = new TestEnvironment({ useExistingCluster: true, config: restConfig });
    const config = await env.start();
    try {
      expect(config.server).toBe(restConfig.server);
      expect(config.user).toBe("unit-user");
      expect(config.apiServerPort).toBe(6443);
      // Nothing was spawned or downloaded.
      expect(config.binaries).toBeUndefined();
      expect(config.etcdURL).toBeUndefined();
      expect(config.installedCRDs).toEqual([]);

      // The written kubeconfig is self-contained and parses back to the
      // same credentials under the cert's identity.
      const reparsed = await parseKubeconfig(config.kubeconfigYaml);
      expect(reparsed.config).toEqual(restConfig);
      expect(reparsed.user).toBe("unit-user");
      await expect(fsp.readFile(config.kubeconfigPath, "utf8")).resolves.toBe(
        config.kubeconfigYaml,
      );

      // The environment does not own the cluster's CA.
      await expect(env.addUser({ name: "nope" })).rejects.toThrow("useExistingCluster");
    } finally {
      await env.stop();
    }
    expect(() => env.config).toThrow("not started");

    // Upstream envtest_test: "should cleanup webhook /tmp folder with no
    // error when using existing cluster" — attach-mode stop() must still
    // remove local temp state (our workdir holds the kubeconfig and any
    // webhook serving certs), even though the cluster itself is left alone.
    await expect(fsp.stat(config.kubeconfigPath)).rejects.toThrow();
  });

  it("normalizes a scheme-less server (like kubectl) and rejects http", async () => {
    // kubectl accepts `server: host:6443` and defaults the scheme; without
    // normalization new URL() would misparse "127.0.0.1:" as the protocol
    // and silently report port 443.
    const env = new TestEnvironment({
      useExistingCluster: true,
      config: { ...restConfig, server: "127.0.0.1:6443" },
    });
    const config = await env.start();
    try {
      expect(config.server).toBe("https://127.0.0.1:6443");
      expect(config.apiServerPort).toBe(6443);
    } finally {
      await env.stop();
    }

    // Everything in this client stack is verified mTLS: plain http can
    // never work, so it fails fast and pointedly.
    const httpEnv = new TestEnvironment({
      useExistingCluster: true,
      config: { ...restConfig, server: "http://127.0.0.1:6443" },
    });
    await expect(httpEnv.start()).rejects.toThrow("must be an https URL");
  });

  it("rejects incomplete explicit credentials fast", async () => {
    // An empty CA/cert/key would otherwise fail much later as an opaque
    // TLS handshake error — attach requires full mTLS credentials.
    for (const field of ["caPem", "certPem", "keyPem"] as const) {
      const env = new TestEnvironment({
        useExistingCluster: true,
        config: { ...restConfig, [field]: "" },
      });
      await expect(env.start()).rejects.toThrow(`options.config.${field} is empty`);
    }
  });

  it("discovers credentials from the kubeconfig at KUBECONFIG", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-attach-"));
    try {
      const file = path.join(dir, "kubeconfig");
      await fsp.writeFile(
        file,
        buildKubeconfig({
          server: restConfig.server,
          caPem: restConfig.caPem,
          clientCertPem: restConfig.certPem,
          clientKeyPem: restConfig.keyPem,
          userName: "kubeconfig-user",
        }),
      );

      const env = new TestEnvironment({ useExistingCluster: true });
      const config = await withEnv({ KUBECONFIG: file }, () => env.start());
      try {
        expect(config.server).toBe(restConfig.server);
        // The cert CN is authoritative, NOT the kubeconfig user-entry name:
        // entry names are arbitrary labels (kind writes "kind-kind" while
        // its cert CN — the identity the apiserver sees — is
        // "kubernetes-admin").
        expect(config.user).toBe("unit-user");
      } finally {
        await env.stop();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unresolvable kubeconfig clearly", async () => {
    const env = new TestEnvironment({ useExistingCluster: true });
    await expect(
      withEnv({ KUBECONFIG: path.join(os.tmpdir(), "envtest-no-such-kubeconfig") }, () =>
        env.start(),
      ),
    ).rejects.toThrow("cannot read kubeconfig");
  });

  // Upstream parity: USE_EXISTING_CLUSTER selects attach mode when the
  // option is unset (case-insensitive), and the option always wins.
  it("honors USE_EXISTING_CLUSTER when the option is unset", async () => {
    const env = new TestEnvironment({ config: restConfig });
    const config = await withEnv({ USE_EXISTING_CLUSTER: "TRUE" }, () => env.start());
    try {
      expect(config.user).toBe("unit-user");
      expect(config.binaries).toBeUndefined();
    } finally {
      await env.stop();
    }
  });

  it("useExistingCluster: false overrides USE_EXISTING_CLUSTER=true", async () => {
    const env = new TestEnvironment({ useExistingCluster: false, config: restConfig });
    await withEnv(
      {
        USE_EXISTING_CLUSTER: "true",
        // Binaries that cannot exist: if the option is respected, start()
        // takes the spawn path and fails on etcd instead of attaching. The
        // TEST_ASSET_* overrides outrank KUBEBUILDER_ASSETS per binary, so
        // they must be cleared or a machine that exports them would spawn
        // its real control-plane binaries here.
        KUBEBUILDER_ASSETS: path.join(os.tmpdir(), "envtest-no-such-binaries"),
        TEST_ASSET_ETCD: undefined,
        TEST_ASSET_KUBE_APISERVER: undefined,
        TEST_ASSET_KUBECTL: undefined,
      },
      () => expect(env.start()).rejects.toThrow(/etcd/),
    );
  });
});
