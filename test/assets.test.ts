// Intentions from upstream envtest_test.go "Binary Path Handling": the
// KUBEBUILDER_ASSETS / TEST_ASSET_* / binaryAssetsDirectory precedence.
// These paths resolve without any network access.
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBinaries } from "../src/setup/assets.js";
import { binaryName } from "../src/setup/platform.js";

const ENV_VARS = [
  "KUBEBUILDER_ASSETS",
  "TEST_ASSET_ETCD",
  "TEST_ASSET_KUBE_APISERVER",
  "TEST_ASSET_KUBECTL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("resolveBinaries precedence", () => {
  it("uses KUBEBUILDER_ASSETS as the binary directory when set", async () => {
    process.env.KUBEBUILDER_ASSETS = path.join("ci", "assets");
    try {
      const bins = await resolveBinaries();
      expect(bins.dir).toBe(path.join("ci", "assets"));
      expect(bins.etcd).toBe(path.join("ci", "assets", binaryName("etcd")));
      expect(bins.kubeApiserver).toBe(path.join("ci", "assets", binaryName("kube-apiserver")));
      expect(bins.kubectl).toBe(path.join("ci", "assets", binaryName("kubectl")));
    } finally {
      delete process.env.KUBEBUILDER_ASSETS;
    }
  });

  it("lets TEST_ASSET_* override individual binaries within an assets directory", async () => {
    process.env.KUBEBUILDER_ASSETS = path.join("ci", "assets");
    process.env.TEST_ASSET_ETCD = path.join("custom", "etcd-special");
    try {
      const bins = await resolveBinaries();
      expect(bins.etcd).toBe(path.join("custom", "etcd-special"));
      // The others still come from the assets dir.
      expect(bins.kubeApiserver).toBe(path.join("ci", "assets", binaryName("kube-apiserver")));
    } finally {
      delete process.env.KUBEBUILDER_ASSETS;
      delete process.env.TEST_ASSET_ETCD;
    }
  });

  it("respects a pre-configured binaryAssetsDirectory without downloading", async () => {
    const bins = await resolveBinaries({ binaryAssetsDirectory: path.join("local", "bin") });
    expect(bins.dir).toBe(path.join("local", "bin"));
    expect(bins.kubectl).toBe(path.join("local", "bin", binaryName("kubectl")));
    expect(bins.version).toBeUndefined();
  });

  it("prefers KUBEBUILDER_ASSETS over binaryAssetsDirectory (upstream precedence)", async () => {
    process.env.KUBEBUILDER_ASSETS = path.join("env", "wins");
    try {
      const bins = await resolveBinaries({ binaryAssetsDirectory: path.join("option", "loses") });
      expect(bins.dir).toBe(path.join("env", "wins"));
    } finally {
      delete process.env.KUBEBUILDER_ASSETS;
    }
  });
});
