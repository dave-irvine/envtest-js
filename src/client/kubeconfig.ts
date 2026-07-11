import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dump as dumpYaml, load as loadYaml } from "js-yaml";

import { type RestConfig } from "./rest.js";

export interface KubeconfigInput {
  server: string;
  caPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  userName?: string;
  clusterName?: string;
}

/** Render a self-contained kubeconfig (all credentials inlined as base64). */
export function buildKubeconfig(input: KubeconfigInput): string {
  const cluster = input.clusterName ?? "envtest";
  const user = input.userName ?? "envtest-admin";
  const b64 = (pem: string) => Buffer.from(pem).toString("base64");
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: cluster,
        cluster: {
          server: input.server,
          "certificate-authority-data": b64(input.caPem),
        },
      },
    ],
    users: [
      {
        name: user,
        user: {
          "client-certificate-data": b64(input.clientCertPem),
          "client-key-data": b64(input.clientKeyPem),
        },
      },
    ],
    contexts: [
      {
        name: cluster,
        context: { cluster, user },
      },
    ],
    "current-context": cluster,
  };
  return dumpYaml(config);
}

/** Credentials and names extracted from one kubeconfig context. */
export interface ParsedKubeconfig {
  /** mTLS REST config for the selected context. */
  config: RestConfig;
  /** Names of the selected context and its cluster/user entries. */
  context: string;
  cluster: string;
  user: string;
}

export interface ParseKubeconfigOptions {
  /** Context to select; defaults to the kubeconfig's current-context. */
  context?: string;
  /**
   * Directory that relative certificate-authority / client-certificate /
   * client-key file references resolve against — kubectl resolves them
   * relative to the kubeconfig file's own directory. Defaults to cwd.
   */
  baseDir?: string;
}

/**
 * Extract an mTLS RestConfig from kubeconfig YAML. Deliberately narrower
 * than kubectl: only client-certificate credentials are supported (what
 * kind/k3d/minikube issue) — token, exec-plugin, and basic auth are not,
 * and a cluster CA is required (no insecure-skip-tls-verify).
 */
export async function parseKubeconfig(
  yamlText: string,
  opts: ParseKubeconfigOptions = {},
): Promise<ParsedKubeconfig> {
  const doc = loadYaml(yamlText) as KubeconfigFile | null | undefined;
  if (!doc || typeof doc !== "object") {
    throw new Error("kubeconfig is empty or not a YAML mapping");
  }
  const contextName = opts.context ?? doc["current-context"];
  if (!contextName) {
    throw new Error("kubeconfig has no current-context; pass an explicit context");
  }
  const context = findNamed(doc.contexts, contextName)?.context;
  if (!context?.cluster || !context.user) {
    throw new Error(`kubeconfig has no usable context named "${contextName}"`);
  }
  const cluster = findNamed(doc.clusters, context.cluster)?.cluster;
  if (!cluster) {
    throw new Error(`kubeconfig has no cluster named "${context.cluster}" (context "${contextName}")`);
  }
  const user = findNamed(doc.users, context.user)?.user;
  if (!user) {
    throw new Error(`kubeconfig has no user named "${context.user}" (context "${contextName}")`);
  }
  const rawServer = cluster.server;
  if (typeof rawServer !== "string" || !rawServer) {
    throw new Error(`kubeconfig cluster "${context.cluster}" has no server`);
  }
  const server = normalizeServerURL(rawServer, `kubeconfig cluster "${context.cluster}" server`);

  const caPem = await pemEntry(cluster, "certificate-authority", opts.baseDir);
  if (!caPem) {
    throw new Error(
      `kubeconfig cluster "${context.cluster}" has no certificate-authority(-data); ` +
        "insecure-skip-tls-verify is not supported",
    );
  }
  const certPem = await pemEntry(user, "client-certificate", opts.baseDir);
  const keyPem = await pemEntry(user, "client-key", opts.baseDir);
  if (!certPem || !keyPem) {
    throw new Error(
      `kubeconfig user "${context.user}" has no client certificate/key; only ` +
        "client-certificate auth is supported (not token, exec, or basic auth)",
    );
  }

  return {
    config: { server, caPem, certPem, keyPem },
    context: contextName,
    cluster: context.cluster,
    user: context.user,
  };
}

/**
 * Validate and normalize a REST server URL. Scheme-less values (kubectl
 * accepts "host:6443" and defaults the scheme) get https:// prepended;
 * anything that still fails to parse — or is not https — is rejected with
 * a pointed error here, instead of surfacing later as an opaque TypeError
 * or wrong-port connection failure. http is rejected because this client
 * stack speaks only verified mTLS.
 */
export function normalizeServerURL(server: string, source: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `https://${server}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${source} is not a valid URL: "${server}"`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${source} must be an https URL, got "${server}"`);
  }
  return withScheme;
}

export interface LoadKubeconfigOptions extends Pick<ParseKubeconfigOptions, "context"> {
  /**
   * Kubeconfig file to load. Default: the first *readable* KUBECONFIG
   * entry (kubectl skips missing files in the list too, though its
   * multi-file merging is not supported here), else ~/.kube/config.
   */
  path?: string;
}

export interface LoadedKubeconfig extends ParsedKubeconfig {
  /** The kubeconfig file the credentials came from. */
  path: string;
}

/** Locate (path option > KUBECONFIG > ~/.kube/config), read, and parse a kubeconfig. */
export async function loadKubeconfig(opts: LoadKubeconfigOptions = {}): Promise<LoadedKubeconfig> {
  const { file, text } = await readKubeconfigFile(opts.path);
  const parsed = await parseKubeconfig(text, { context: opts.context, baseDir: path.dirname(file) });
  return { ...parsed, path: file };
}

async function readKubeconfigFile(explicit?: string): Promise<{ file: string; text: string }> {
  if (explicit) {
    try {
      return { file: explicit, text: await fsp.readFile(explicit, "utf8") };
    } catch (err) {
      throw new Error(`cannot read kubeconfig at ${explicit}: ${(err as Error).message}`);
    }
  }
  // The first READABLE entry wins: CI tooling commonly prepends
  // possibly-absent paths to KUBECONFIG, and kubectl tolerates those by
  // skipping them (it then merges the rest, which we don't).
  const entries = (process.env.KUBECONFIG ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = entries.length ? entries : [path.join(os.homedir(), ".kube", "config")];
  const failures: string[] = [];
  for (const file of candidates) {
    try {
      return { file, text: await fsp.readFile(file, "utf8") };
    } catch (err) {
      failures.push(`${file}: ${(err as Error).message}`);
    }
  }
  const source = entries.length ? "any KUBECONFIG entry" : "~/.kube/config";
  throw new Error(`cannot read kubeconfig from ${source} (${failures.join("; ")})`);
}

interface KubeconfigFile {
  "current-context"?: string;
  contexts?: Array<{ name?: string; context?: { cluster?: string; user?: string } }>;
  clusters?: Array<{ name?: string; cluster?: Record<string, unknown> }>;
  users?: Array<{ name?: string; user?: Record<string, unknown> }>;
}

function findNamed<T extends { name?: string }>(list: T[] | undefined, name: string): T | undefined {
  return (Array.isArray(list) ? list : []).find((entry) => entry?.name === name);
}

/** "<field>-data" (inline base64) wins over "<field>" (file reference), then undefined. */
async function pemEntry(
  entry: Record<string, unknown>,
  field: string,
  baseDir: string | undefined,
): Promise<string | undefined> {
  const data = entry[`${field}-data`];
  if (typeof data === "string" && data) {
    // Node's base64 decoder silently skips invalid characters, which would
    // turn corrupted data into garbage PEM that only fails much later as an
    // opaque TLS error — reject it here instead, like client-go does.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`invalid base64 in "${field}-data"`);
    }
    return Buffer.from(data, "base64").toString();
  }
  const file = entry[field];
  if (typeof file === "string" && file) {
    return fsp.readFile(path.resolve(baseDir ?? ".", file), "utf8");
  }
  return undefined;
}
