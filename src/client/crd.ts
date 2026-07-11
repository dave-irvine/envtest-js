import fsp from "node:fs/promises";
import path from "node:path";
import { loadAll as parseYamlDocuments } from "js-yaml";

import { setTimeout as sleep } from "node:timers/promises";

import { createOrReplace, restRequest, type RestConfig } from "./rest.js";
import { rewriteConversionWebhooks, type CRDConversionTarget } from "./webhook.js";

const CRD_BASE = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions";

export interface InstallCRDsOptions {
  /** Max time to wait for each CRD to reach the Established condition. */
  establishTimeoutMs?: number;
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
 * directories of files) and wait until each reports Established=True,
 * mirroring envtest.InstallCRDs.
 *
 * Returns the names of the CRDs installed.
 */
export async function installCRDs(
  config: RestConfig,
  paths: string[],
  opts: InstallCRDsOptions = {},
): Promise<string[]> {
  let crds = await readCRDManifests(paths);
  if (opts.conversionWebhook) {
    const { host, port, caPem } = opts.conversionWebhook;
    crds = rewriteConversionWebhooks(crds, host, port, caPem);
  }
  for (const crd of crds) {
    await createOrReplace(config, CRD_BASE, crd);
  }
  const timeout = opts.establishTimeoutMs ?? 30_000;
  for (const crd of crds) {
    await waitForEstablished(config, crd.metadata.name, timeout);
  }
  return crds.map((c) => c.metadata.name);
}

interface CRDManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; resourceVersion?: string };
  spec?: CRDConversionTarget["spec"];
  [key: string]: unknown;
}

async function readCRDManifests(paths: string[]): Promise<CRDManifest[]> {
  const files: string[] = [];
  for (const p of paths) {
    const stat = await fsp.stat(p);
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
    await sleep(100);
  }
  throw new Error(`CRD ${name} did not become Established within ${timeoutMs}ms (${lastState})`);
}
