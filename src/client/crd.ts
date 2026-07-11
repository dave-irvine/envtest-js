import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadAll as parseYamlDocuments } from "js-yaml";

import { setTimeout as sleep } from "node:timers/promises";

import { createOrReplace, restRequest, type RestConfig } from "./rest.js";
import { rewriteConversionWebhooks, type CRDConversionTarget } from "./webhook.js";

const CRD_BASE = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions";

export interface InstallCRDsOptions {
  /**
   * In-memory CRD manifests, installed before those read from paths
   * (upstream: CRDInstallOptions.CRDs). Lets tests generate definitions
   * programmatically instead of shipping YAML fixtures. The objects are
   * never mutated.
   */
  crds?: CRDManifest[];
  /**
   * Whether a non-existent entry in `paths` is an error (upstream:
   * CRDInstallOptions.ErrorIfPathMissing). Defaults to true — deliberately
   * stricter than upstream, which silently skips missing paths by default.
   * Set false for upstream-style skipping.
   */
  errorIfPathMissing?: boolean;
  /** Max time to wait for each CRD to reach the Established condition. */
  establishTimeoutMs?: number;
  /**
   * Interval between checks of the Established condition (upstream:
   * CRDInstallOptions.PollInterval). Default 100ms.
   */
  pollIntervalMs?: number;
  /**
   * Local webhook serving details. When set, CRDs declaring
   * `spec.conversion.strategy: Webhook` get their conversion clientConfig
   * pointed at this address with the CA injected (upstream:
   * CRDInstallOptions.WebhookOptions). TestEnvironment fills this in
   * automatically when started with webhookInstallOptions.
   */
  conversionWebhook?: { host: string; port: number; caPem: string };
}

/**
 * Install CustomResourceDefinitions from YAML/JSON manifests (files or
 * directories of files) and/or in-memory objects (opts.crds), and wait until
 * each reports Established=True, mirroring envtest.InstallCRDs.
 *
 * Returns the names of the CRDs installed.
 */
export async function installCRDs(
  config: RestConfig,
  paths: string[],
  opts: InstallCRDsOptions = {},
): Promise<string[]> {
  const timeout = opts.establishTimeoutMs ?? 30_000;
  const pollInterval = opts.pollIntervalMs ?? 100;
  if (!Number.isFinite(pollInterval) || pollInterval <= 0) {
    throw new Error(`pollIntervalMs must be a positive number, got ${pollInterval}`);
  }
  let crds = [
    ...validateCRDManifests(opts.crds ?? []),
    ...(await readCRDManifests(paths, opts.errorIfPathMissing ?? true)),
  ];
  if (opts.conversionWebhook) {
    const { host, port, caPem } = opts.conversionWebhook;
    crds = rewriteConversionWebhooks(crds, host, port, caPem);
  }
  for (const crd of crds) {
    await createOrReplace(config, CRD_BASE, crd);
  }
  for (const crd of crds) {
    await waitForEstablished(config, crd.metadata.name, timeout, pollInterval);
  }
  return crds.map((c) => c.metadata.name);
}

/**
 * Delete the CustomResourceDefinitions named by the given YAML/JSON manifests
 * (files or directories of files) and/or in-memory objects (opts.crds),
 * mirroring envtest.UninstallCRDs. CRDs that don't exist are skipped. Like
 * upstream, this returns once the delete calls are accepted — the apiserver
 * finishes removal (and drops the served API groups) asynchronously.
 *
 * Returns the names of the CRDs deleted (not-found ones excluded).
 */
export async function uninstallCRDs(
  config: RestConfig,
  paths: string[],
  opts: Pick<InstallCRDsOptions, "crds" | "errorIfPathMissing"> = {},
): Promise<string[]> {
  const crds = [
    ...validateCRDManifests(opts.crds ?? []),
    ...(await readCRDManifests(paths, opts.errorIfPathMissing ?? true)),
  ];
  const deleted: string[] = [];
  for (const crd of crds) {
    const name = crd.metadata.name;
    const res = await restRequest(config, "DELETE", `${CRD_BASE}/${name}`);
    if (res.status === 404) continue;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `failed to delete CRD ${name}: HTTP ${res.status}: ${res.json?.message ?? res.text.slice(0, 500)}`,
      );
    }
    deleted.push(name);
  }
  return deleted;
}

export interface CRDManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; resourceVersion?: string };
  spec?: CRDConversionTarget["spec"];
  [key: string]: unknown;
}

/**
 * In-memory manifests are trusted as authored (no kind-based filtering like
 * the file path does) — but a wrong kind or missing name is certainly a
 * caller bug, so fail loudly instead of letting the apiserver 404 later.
 */
function validateCRDManifests(crds: CRDManifest[]): CRDManifest[] {
  for (const crd of crds) {
    if (crd.kind !== "CustomResourceDefinition") {
      throw new Error(
        `in-memory CRD manifest${crd.metadata?.name ? ` "${crd.metadata.name}"` : ""} has kind ${JSON.stringify(crd.kind)}, expected "CustomResourceDefinition"`,
      );
    }
    if (!crd.metadata?.name) {
      throw new Error("in-memory CustomResourceDefinition has no metadata.name");
    }
  }
  return crds;
}

async function readCRDManifests(
  paths: string[],
  errorIfPathMissing: boolean,
): Promise<CRDManifest[]> {
  const files: string[] = [];
  for (const p of paths) {
    let stat: Stats;
    try {
      stat = await fsp.stat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (errorIfPathMissing) throw new Error(`CRD path does not exist: ${p}`);
        continue;
      }
      throw err;
    }
    if (stat.isDirectory()) {
      // Like upstream: non-recursive read of manifest files in the directory.
      for (const entry of await fsp.readdir(p)) {
        if (/\.(ya?ml|json)$/i.test(entry)) files.push(path.join(p, entry));
      }
    } else {
      files.push(p);
    }
  }

  const crds: CRDManifest[] = [];
  for (const file of files) {
    const text = await fsp.readFile(file, "utf8");
    for (const doc of parseYamlDocuments(text)) {
      if (!doc || typeof doc !== "object") continue;
      const obj = doc as CRDManifest;
      if (obj.kind === "CustomResourceDefinition") {
        if (!obj.metadata?.name) {
          throw new Error(`CustomResourceDefinition in ${file} has no metadata.name`);
        }
        crds.push(obj);
      }
    }
  }
  return crds;
}

async function waitForEstablished(
  config: RestConfig,
  name: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "no conditions reported yet";
  while (Date.now() < deadline) {
    const res = await restRequest(config, "GET", `${CRD_BASE}/${name}`);
    if (res.status === 200) {
      const conditions: Array<{ type: string; status: string; message?: string }> =
        res.json?.status?.conditions ?? [];
      const established = conditions.find((c) => c.type === "Established");
      if (established?.status === "True") return;
      const namesAccepted = conditions.find((c) => c.type === "NamesAccepted");
      if (namesAccepted?.status === "False") {
        throw new Error(`CRD ${name} names not accepted: ${namesAccepted.message}`);
      }
      lastState = JSON.stringify(conditions);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`CRD ${name} did not become Established within ${timeoutMs}ms (${lastState})`);
}
