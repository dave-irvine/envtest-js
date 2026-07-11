// Intentions from upstream setup-envtest store_test.go (archive handling)
// plus checksum verification: served from a local HTTP server, no network.
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadArchive, hasAllBinaries } from "../src/setup/download.js";
import { binaryName } from "../src/setup/platform.js";

let workDir: string;
let baseURL: string;
let requestCount = 0;
let server: http.Server;
let tarballBytes: Buffer;
let goodHash: string;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-download-test-"));

  // Craft an archive with the controller-tools nesting; extraction must find
  // the binaries "regardless of path" (upstream store_test intention).
  // The fake binaries are padded to 1MB: Bun's node-tar compat silently
  // drops extracted files smaller than ~512KB (bisected experimentally;
  // real control-plane binaries are 30MB+, so production is unaffected).
  const srcDir = path.join(workDir, "archive-src", "controller-tools", "envtest");
  await fsp.mkdir(srcDir, { recursive: true });
  for (const bin of ["etcd", "kube-apiserver", "kubectl"]) {
    const content = Buffer.concat([Buffer.from(`fake ${bin}\n`), randomBytes(1024 * 1024)]);
    await fsp.writeFile(path.join(srcDir, binaryName(bin)), content);
  }
  const tarballPath = path.join(workDir, "envtest.tar.gz");
  await tar.c(
    { gzip: true, file: tarballPath, cwd: path.join(workDir, "archive-src") },
    ["controller-tools"],
  );
  tarballBytes = await fsp.readFile(tarballPath);
  goodHash = createHash("sha512").update(tarballBytes).digest("hex");

  server = http.createServer((req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(tarballBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(workDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("downloadArchive", () => {
  it("verifies the checksum, extracts binaries regardless of archive layout, and is idempotent", async () => {
    const destDir = path.join(workDir, "dest-ok");
    await downloadArchive({ hash: goodHash, selfLink: `${baseURL}/envtest.tar.gz` }, destDir);
    expect(await hasAllBinaries(destDir)).toBe(true);
    // The controller-tools/envtest/ nesting must not survive extraction.
    const etcd = await fsp.readFile(path.join(destDir, binaryName("etcd")));
    expect(etcd.subarray(0, 10).toString()).toContain("fake etcd");

    // Second call: already installed -> no new HTTP request.
    const before = requestCount;
    await downloadArchive({ hash: goodHash, selfLink: `${baseURL}/envtest.tar.gz` }, destDir);
    expect(requestCount).toBe(before);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    const destDir = path.join(workDir, "dest-bad");
    const err = await downloadArchive(
      { hash: "deadbeef".repeat(16), selfLink: `${baseURL}/envtest.tar.gz` },
      destDir,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/SHA-512 mismatch/);
    // Upstream: "should clean up if it errors before finishing".
    expect(await hasAllBinaries(destDir)).toBe(false);
    const staging = (await fsp.readdir(workDir)).filter((f) => f.startsWith("dest-bad.tmp-"));
    expect(staging).toHaveLength(0);
  });
});
