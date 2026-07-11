import fsp from "node:fs/promises";
import path from "node:path";
import semver from "semver";

import { defaultDataDir } from "./platform.js";

/**
 * Management of the local binary cache, mirroring setup-envtest's
 * `list -i` and `cleanup` commands (pkg/store in kubernetes-sigs/controller-tools).
 * Cached versions live in <dataDir>/k8s/<version>-<os>-<arch>.
 */

export interface CachedVersion {
  /** Envtest version, e.g. "v1.36.2". */
  version: string;
  /** GOOS name from the directory suffix, e.g. "linux". */
  os: string;
  /** GOARCH name from the directory suffix, e.g. "amd64". */
  arch: string;
  /** Absolute directory the binaries live in. */
  dir: string;
}

export interface CacheFilter {
  /**
   * Version selector: exact ("v1.36.2") or a semver range ("1.36",
   * "<1.30"). Ranges never match prereleases; those must be named exactly.
   * Anything unparseable throws rather than silently matching nothing.
   */
  version?: string;
  /** GOOS name, e.g. "linux". Defaults to all. */
  os?: string;
  /** GOARCH name, e.g. "amd64". Defaults to all. */
  arch?: string;
  /** Cache directory root (defaults to the platform data dir). */
  dataDir?: string;
}

// Greedy version group so prerelease hyphens ("v1.37.0-alpha.1") stay in the
// version; the final two segments are always os and arch. GOOS names are
// letters only, which keeps download staging dirs ("...-linux-amd64.tmp-1-2")
// from parsing as versions.
const ENTRY_RE = /^(v.+)-([a-z]+)-([a-z0-9]+)$/;

function validateVersionFilter(version: string): void {
  const bare = version.replace(/^v/, "");
  if (semver.valid(bare) === null && semver.validRange(bare) === null) {
    throw new Error(
      `invalid version filter "${version}": expected an exact version ("v1.36.2") or a semver range ("1.36", "<1.30")`,
    );
  }
}

function matches(entry: CachedVersion, filter: CacheFilter): boolean {
  if (filter.os && entry.os !== filter.os) return false;
  if (filter.arch && entry.arch !== filter.arch) return false;
  if (filter.version) {
    const exact = filter.version.startsWith("v") ? filter.version : `v${filter.version}`;
    if (entry.version === exact) return true;
    const range = filter.version.replace(/^v/, "");
    return semver.validRange(range) !== null && semver.satisfies(entry.version, range);
  }
  return true;
}

/**
 * List cached envtest versions, newest first. Directories whose names don't
 * parse as <version>-<os>-<arch> (e.g. in-flight download staging dirs) are
 * ignored.
 */
export async function listCachedVersions(filter: CacheFilter = {}): Promise<CachedVersion[]> {
  if (filter.version) validateVersionFilter(filter.version);
  const k8sDir = path.join(filter.dataDir ?? defaultDataDir(), "k8s");

  let names: string[];
  try {
    const entries = await fsp.readdir(k8sDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const cached: CachedVersion[] = [];
  for (const name of names) {
    const m = ENTRY_RE.exec(name);
    if (!m || semver.valid(m[1]) === null) continue;
    const entry = { version: m[1], os: m[2], arch: m[3], dir: path.join(k8sDir, name) };
    if (matches(entry, filter)) cached.push(entry);
  }

  return cached.sort(
    (a, b) => semver.rcompare(a.version, b.version) || a.dir.localeCompare(b.dir),
  );
}

/**
 * Remove cached envtest versions matching the filter, mirroring
 * `setup-envtest cleanup`. Returns the entries that were removed.
 */
export async function cleanupCachedVersions(filter: CacheFilter = {}): Promise<CachedVersion[]> {
  const entries = await listCachedVersions(filter);
  for (const entry of entries) {
    await fsp.rm(entry.dir, { recursive: true, force: true });
  }
  return entries;
}
