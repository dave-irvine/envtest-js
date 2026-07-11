// Intentions from upstream setup-envtest store_test.go: listing cached
// versions (sorted, filtered) and removing them via cleanup. Pure filesystem,
// no network.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupCachedVersions, listCachedVersions } from "../src/setup/store.js";

let dataDir: string;

const ENTRIES = [
  "v1.36.2-linux-amd64",
  "v1.36.0-linux-amd64",
  "v1.28.4-linux-amd64",
  "v1.36.2-darwin-arm64",
  "v1.36.2-windows-amd64",
  "v1.37.0-alpha.1-linux-amd64",
];

async function seed(dir: string): Promise<void> {
  for (const name of ENTRIES) {
    await fsp.mkdir(path.join(dir, "k8s", name), { recursive: true });
    await fsp.writeFile(path.join(dir, "k8s", name, "etcd"), "fake etcd\n");
  }
  // Noise that must be ignored: download staging leftovers, unparseable
  // names, and stray files.
  await fsp.mkdir(path.join(dir, "k8s", "v1.36.2-linux-amd64.tmp-123-456"), { recursive: true });
  await fsp.mkdir(path.join(dir, "k8s", "not-a-version"), { recursive: true });
  await fsp.writeFile(path.join(dir, "k8s", "stray-file"), "");
}

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-store-test-"));
  await seed(dataDir);
});

afterAll(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("listCachedVersions", () => {
  it("lists parseable version directories newest-first, ignoring noise", async () => {
    const cached = await listCachedVersions({ dataDir });
    expect(cached.map((c) => `${c.version}-${c.os}-${c.arch}`)).toEqual([
      "v1.37.0-alpha.1-linux-amd64",
      "v1.36.2-darwin-arm64",
      "v1.36.2-linux-amd64",
      "v1.36.2-windows-amd64",
      "v1.36.0-linux-amd64",
      "v1.28.4-linux-amd64",
    ]);
    expect(cached[0].dir).toBe(path.join(dataDir, "k8s", "v1.37.0-alpha.1-linux-amd64"));
  });

  it("filters by os and arch", async () => {
    const linux = await listCachedVersions({ dataDir, os: "linux", arch: "amd64" });
    expect(linux.every((c) => c.os === "linux" && c.arch === "amd64")).toBe(true);
    expect(linux).toHaveLength(4);

    const arm = await listCachedVersions({ dataDir, arch: "arm64" });
    expect(arm.map((c) => c.arch)).toEqual(["arm64"]);
  });

  it("filters by exact version, with or without the v prefix", async () => {
    for (const version of ["v1.36.2", "1.36.2"]) {
      const cached = await listCachedVersions({ dataDir, version });
      expect(cached.map((c) => c.version)).toEqual(["v1.36.2", "v1.36.2", "v1.36.2"]);
    }
  });

  it("filters by semver range, excluding prereleases", async () => {
    const series = await listCachedVersions({ dataDir, version: "1.36" });
    expect(series.map((c) => c.version)).toEqual(["v1.36.2", "v1.36.2", "v1.36.2", "v1.36.0"]);

    const old = await listCachedVersions({ dataDir, version: "<1.30" });
    expect(old.map((c) => c.version)).toEqual(["v1.28.4"]);

    // Ranges never match prereleases; exact requests do.
    const range = await listCachedVersions({ dataDir, version: ">=1.37" });
    expect(range).toHaveLength(0);
    const exact = await listCachedVersions({ dataDir, version: "v1.37.0-alpha.1" });
    expect(exact.map((c) => c.version)).toEqual(["v1.37.0-alpha.1"]);
  });

  it("rejects an unparseable version filter instead of silently matching nothing", async () => {
    await expect(listCachedVersions({ dataDir, version: "banana" })).rejects.toThrow(
      /invalid version filter "banana"/,
    );
    await expect(cleanupCachedVersions({ dataDir, version: "banana" })).rejects.toThrow(
      /invalid version filter/,
    );
  });

  it("returns an empty list when the cache directory does not exist", async () => {
    const cached = await listCachedVersions({ dataDir: path.join(dataDir, "missing") });
    expect(cached).toEqual([]);
  });
});

describe("cleanupCachedVersions", () => {
  it("removes only the matching version directories and reports them", async () => {
    const cleanupDir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-store-cleanup-"));
    try {
      await seed(cleanupDir);

      const removed = await cleanupCachedVersions({ dataDir: cleanupDir, version: "1.36" });
      expect(removed.map((c) => `${c.version}-${c.os}-${c.arch}`).sort()).toEqual([
        "v1.36.0-linux-amd64",
        "v1.36.2-darwin-arm64",
        "v1.36.2-linux-amd64",
        "v1.36.2-windows-amd64",
      ]);
      for (const entry of removed) {
        await expect(fsp.access(entry.dir)).rejects.toThrow();
      }

      // Everything else survives, including the ignored noise entries.
      const remaining = await listCachedVersions({ dataDir: cleanupDir });
      expect(remaining.map((c) => c.version)).toEqual(["v1.37.0-alpha.1", "v1.28.4"]);
      // Throws if cleanup wrongly deleted the unparseable directory.
      await fsp.access(path.join(cleanupDir, "k8s", "not-a-version"));
    } finally {
      await fsp.rm(cleanupDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
