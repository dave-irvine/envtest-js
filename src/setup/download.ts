import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";

import { binaryName } from "./platform.js";
import type { ReleaseArchive } from "./releases.js";

export const CONTROL_PLANE_BINARIES = ["etcd", "kube-apiserver", "kubectl"] as const;

/**
 * Download an envtest archive, verify its SHA-512 digest, and extract the
 * control-plane binaries into destDir. Idempotent: if destDir already holds
 * all three binaries, this is a no-op.
 */
export async function downloadArchive(
  archive: ReleaseArchive,
  destDir: string,
  opts: { onProgress?: (message: string) => void } = {},
): Promise<void> {
  if (await hasAllBinaries(destDir)) return;

  const log = opts.onProgress ?? (() => {});
  await fsp.mkdir(path.dirname(destDir), { recursive: true });
  const staging = `${destDir}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(staging, { recursive: true });

  try {
    const tarball = path.join(staging, "envtest.tar.gz");
    log(`downloading ${archive.selfLink}`);
    const res = await fetch(archive.selfLink, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`failed to download ${archive.selfLink}: HTTP ${res.status}`);
    }
    const tarballFile = await fsp.open(tarball, "w");
    await pipeline(
      Readable.fromWeb(res.body as import("stream/web").ReadableStream),
      tarballFile.createWriteStream(), // closes the handle when the stream ends
    );

    const digest = await sha512File(tarball);
    if (digest !== archive.hash.toLowerCase()) {
      throw new Error(
        `SHA-512 mismatch for ${archive.selfLink}:\n  expected ${archive.hash}\n  got      ${digest}`,
      );
    }

    log("extracting control plane binaries");
    const extractDir = path.join(staging, "extracted");
    await fsp.mkdir(extractDir);
    await tar.x({ file: tarball, cwd: extractDir });

    // Archives contain a controller-tools/envtest/ prefix; locate the
    // binaries wherever they landed rather than assuming the layout.
    const wanted = new Set(CONTROL_PLANE_BINARIES.map((b) => binaryName(b)));
    const binDir = path.join(staging, "bin");
    await fsp.mkdir(binDir);
    let found = 0;
    for await (const file of walk(extractDir)) {
      if (wanted.has(path.basename(file))) {
        await fsp.copyFile(file, path.join(binDir, path.basename(file)));
        if (process.platform !== "win32") {
          await fsp.chmod(path.join(binDir, path.basename(file)), 0o755);
        }
        found++;
      }
    }
    if (found < wanted.size) {
      throw new Error(
        `archive ${archive.selfLink} did not contain all expected binaries (${[...wanted].join(", ")})`,
      );
    }

    // Move into place; if a concurrent process won the race, keep theirs.
    // A leftover partial install (crashed extraction) is removed and
    // replaced, like upstream store.Add cleaning any existing item dir.
    try {
      await fsp.rename(binDir, destDir);
    } catch {
      if (!(await hasAllBinaries(destDir))) {
        await fsp.rm(destDir, { recursive: true, force: true });
        await fsp.rename(binDir, destDir);
      }
    }
    log(`envtest binaries installed to ${destDir}`);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

export async function hasAllBinaries(dir: string): Promise<boolean> {
  for (const bin of CONTROL_PLANE_BINARIES) {
    try {
      await fsp.access(path.join(dir, binaryName(bin)));
    } catch {
      return false;
    }
  }
  return true;
}

async function sha512File(file: string): Promise<string> {
  const hash = createHash("sha512");
  const handle = await fsp.open(file, "r");
  await pipeline(handle.createReadStream(), hash);
  return hash.digest("hex");
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
