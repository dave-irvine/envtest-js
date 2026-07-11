import { load as parseYaml } from "js-yaml";
import semver from "semver";

/**
 * Client for the upstream envtest binary index
 * (envtest-releases.yaml in kubernetes-sigs/controller-tools).
 */

export const DEFAULT_INDEX_URL =
  "https://raw.githubusercontent.com/kubernetes-sigs/controller-tools/HEAD/envtest-releases.yaml";

export interface ReleaseArchive {
  /** SHA-512 hex digest of the tarball. */
  hash: string;
  /** Download URL. */
  selfLink: string;
}

export interface ReleaseIndex {
  /** version (e.g. "v1.36.2") -> archive file name -> archive info */
  releases: Record<string, Record<string, ReleaseArchive>>;
}

export function parseReleaseIndex(text: string): ReleaseIndex {
  const doc = parseYaml(text) as ReleaseIndex | null | undefined;
  if (!doc || typeof doc !== "object" || typeof doc.releases !== "object" || doc.releases === null) {
    throw new Error("invalid envtest release index: missing top-level 'releases' map");
  }
  return { releases: doc.releases };
}

export async function fetchReleaseIndex(url: string = DEFAULT_INDEX_URL): Promise<ReleaseIndex> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch envtest release index from ${url}: HTTP ${res.status}`);
  }
  return parseReleaseIndex(await res.text());
}

/**
 * Pick a version from the index.
 *
 * - No argument: the latest stable (non-prerelease) version.
 * - Exact version ("v1.36.2" / "1.36.2" / "v1.37.0-alpha.1"): that version, if present.
 * - Anything else is treated as a semver range: "1.36" selects the latest
 *   stable patch of that series, and full range syntax (">=1.35 <1.37") works
 *   too. Ranges never match prereleases (standard semver semantics), so
 *   prereleases must be requested exactly.
 */
export function selectVersion(index: ReleaseIndex, requested?: string): string {
  const available = Object.keys(index.releases).filter((v) => semver.valid(v) !== null);
  if (available.length === 0) {
    throw new Error("envtest release index contains no parseable versions");
  }

  if (requested) {
    const exact = requested.startsWith("v") ? requested : `v${requested}`;
    if (index.releases[exact]) return exact;
  }

  const range = requested ? requested.replace(/^v/, "") : "*";
  const best = semver.validRange(range) ? semver.maxSatisfying(available, range) : null;
  if (best) return best;

  if (!requested) throw new Error("no stable versions in envtest release index");
  throw new Error(
    `envtest version "${requested}" not found in release index (available: ${Object.keys(index.releases).slice(-8).join(", ")})`,
  );
}

/** Resolve the archive entry for a version/os/arch combination. */
export function archiveFor(
  index: ReleaseIndex,
  version: string,
  osName: string,
  arch: string,
): ReleaseArchive & { name: string } {
  const release = index.releases[version];
  if (!release) throw new Error(`version ${version} not in release index`);
  const name = `envtest-${version}-${osName}-${arch}.tar.gz`;
  const archive = release[name];
  if (!archive) {
    throw new Error(
      `no envtest archive for ${osName}/${arch} in ${version} (available: ${Object.keys(release).join(", ")})`,
    );
  }
  return { name, ...archive };
}
