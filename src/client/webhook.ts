import fsp from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import { loadAll as parseYamlDocuments } from "js-yaml";

import { hostPort } from "../controlplane/ports.js";
import { createOrReplace, type RestConfig } from "./rest.js";

/**
 * Admission-webhook install — a port of envtest's WebhookInstallOptions
 * (pkg/envtest/webhook.go). The webhook *server* runs in the test process;
 * envtest-js mints its serving certificate, rewrites the webhook
 * configurations to call back at https://<localServingHost>:<port>, injects
 * the CA bundle so the apiserver trusts that callback, and applies the
 * configurations to the cluster.
 */

const API_BASE = "/apis/admissionregistration.k8s.io/v1";

const KIND_TO_PLURAL: Record<string, string> = {
  ValidatingWebhookConfiguration: "validatingwebhookconfigurations",
  MutatingWebhookConfiguration: "mutatingwebhookconfigurations",
};

export interface WebhookInstallOptions {
  /**
   * Manifests (files or directories) containing
   * (Validating|Mutating)WebhookConfiguration documents.
   */
  paths: string[];
  /** Host the in-test webhook server will listen on (default 127.0.0.1). */
  localServingHost?: string;
  /** Port for the in-test webhook server (default: a free port). */
  localServingPort?: number;
}

export interface WebhookClientConfig {
  url?: string;
  caBundle?: string;
  service?: { name: string; namespace: string; path?: string; port?: number };
}

export interface WebhookConfigurationManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; resourceVersion?: string };
  webhooks?: Array<{ name: string; clientConfig?: WebhookClientConfig; [key: string]: unknown }>;
  [key: string]: unknown;
}

export async function readWebhookManifests(
  paths: string[],
): Promise<WebhookConfigurationManifest[]> {
  const files: string[] = [];
  for (const p of paths) {
    const stat = await fsp.stat(p);
    if (stat.isDirectory()) {
      for (const entry of await fsp.readdir(p)) {
        if (/\.(ya?ml|json)$/i.test(entry)) files.push(path.join(p, entry));
      }
    } else {
      files.push(p);
    }
  }

  const manifests: WebhookConfigurationManifest[] = [];
  for (const file of files) {
    const text = await fsp.readFile(file, "utf8");
    for (const doc of parseYamlDocuments(text)) {
      if (!doc || typeof doc !== "object") continue;
      const obj = doc as WebhookConfigurationManifest;
      if (obj.kind in KIND_TO_PLURAL) {
        if (!obj.metadata?.name) {
          throw new Error(`${obj.kind} in ${file} has no metadata.name`);
        }
        manifests.push(obj);
      }
    }
  }
  return manifests;
}

/**
 * Point every webhook at the in-test server: replace `clientConfig.service`
 * with a direct URL (keeping the service's path), and inject the CA bundle
 * the apiserver must trust. Mirrors upstream's modifyWebhookDefinitions.
 * Returns rewritten copies; the inputs are not mutated.
 */
export function rewriteWebhookManifests(
  manifests: WebhookConfigurationManifest[],
  host: string,
  port: number,
  caPem: string,
): WebhookConfigurationManifest[] {
  const caBundle = Buffer.from(caPem).toString("base64");
  return manifests.map((manifest) => {
    const clone = structuredClone(manifest);
    for (const hook of clone.webhooks ?? []) {
      const clientConfig = (hook.clientConfig ??= {});
      const servingPath =
        clientConfig.service?.path ??
        (clientConfig.url ? new URL(clientConfig.url).pathname : "/");
      delete clientConfig.service;
      clientConfig.url = `https://${hostPort(host, port)}${servingPath}`;
      clientConfig.caBundle = caBundle;
    }
    return clone;
  });
}

/** The subset of a CRD manifest that conversion-webhook patching touches. */
export interface CRDConversionTarget {
  kind: string;
  metadata: { name: string };
  spec?: {
    conversion?: {
      strategy?: string;
      webhook?: {
        conversionReviewVersions?: string[];
        clientConfig?: WebhookClientConfig;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Point CRD conversion webhooks at the in-test server — upstream's
 * modifyConversionWebhooks. Go decides which CRDs are convertible by
 * consulting the runtime scheme; with no scheme in JS, we patch exactly the
 * CRDs whose manifest declares `spec.conversion.strategy: Webhook` (what
 * kubebuilder generates for conversion types). The authored service path is
 * kept, defaulting to controller-runtime's fixed /convert endpoint.
 * Returns rewritten copies; the inputs are not mutated.
 */
export function rewriteConversionWebhooks<T extends CRDConversionTarget>(
  crds: T[],
  host: string,
  port: number,
  caPem: string,
): T[] {
  const caBundle = Buffer.from(caPem).toString("base64");
  return crds.map((crd) => {
    if (crd.spec?.conversion?.strategy !== "Webhook") return crd;
    const clone = structuredClone(crd);
    const conversion = clone.spec!.conversion!;
    const clientConfig = conversion.webhook?.clientConfig ?? {};
    const servingPath =
      clientConfig.service?.path ??
      (clientConfig.url ? new URL(clientConfig.url).pathname : "/convert");
    conversion.webhook = {
      conversionReviewVersions: conversion.webhook?.conversionReviewVersions ?? ["v1", "v1beta1"],
      clientConfig: {
        url: `https://${hostPort(host, port)}${servingPath}`,
        caBundle,
      },
    };
    return clone;
  });
}

/** Apply (create-or-replace) webhook configurations; returns their names. */
export async function installWebhooks(
  config: RestConfig,
  manifests: WebhookConfigurationManifest[],
): Promise<string[]> {
  for (const manifest of manifests) {
    await createOrReplace(config, `${API_BASE}/${KIND_TO_PLURAL[manifest.kind]}`, manifest);
  }
  return manifests.map((m) => m.metadata.name);
}

export interface WaitForWebhookServerOptions {
  /**
   * PEM CA the webhook server's certificate must verify against — pass
   * config.webhook.caPem (TestEnvironment.waitForWebhookServer does so
   * automatically). Required: the environment always mints the webhook CA,
   * so this check proves the server is serving a cert the apiserver will
   * actually trust, not merely that something is listening.
   */
  caPem: string;
  timeoutMs?: number;
}

/**
 * Poll until the webhook server completes a CA-verified TLS handshake at
 * host:port — the dial-check from the kubebuilder book's webhook test
 * pattern, with real certificate verification instead of its
 * InsecureSkipVerify. Call this after starting your webhook server, before
 * exercising requests that trigger it.
 */
export async function waitForWebhookServer(
  host: string,
  port: number,
  opts: WaitForWebhookServerOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    lastError = await tryConnectTLS(host, port, opts.caPem);
    if (lastError === undefined) return;
    await sleep(100);
  }
  const certHint =
    lastError && /certificate|cert/i.test(lastError.message)
      ? " — is the server using the certPem/keyPem from config.webhook?"
      : "";
  throw new Error(
    `webhook server at ${hostPort(host, port)} did not accept verified TLS connections within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${lastError.message})` : "") +
      certHint,
  );
}

/** Resolves undefined on a successful CA-verified handshake. */
function tryConnectTLS(host: string, port: number, caPem: string): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, ca: caPem }, () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(new Error("connection attempt timed out"));
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve(err);
    });
  });
}
