import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readWebhookManifests,
  rewriteConversionWebhooks,
  rewriteWebhookManifests,
  type CRDConversionTarget,
  type WebhookConfigurationManifest,
} from "../src/client/webhook.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CA_PEM = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n";

describe("readWebhookManifests", () => {
  it("reads webhook configurations and ignores other kinds", async () => {
    // Point at the whole fixtures dir: the CRD fixture must be skipped.
    const manifests = await readWebhookManifests([FIXTURES]);
    expect(manifests.map((m) => m.metadata.name)).toEqual(["envtest-deny-labeled"]);
    expect(manifests[0].kind).toBe("ValidatingWebhookConfiguration");
  });
});

describe("rewriteWebhookManifests", () => {
  it("replaces service refs with a direct URL (keeping the path) and injects caBundle", async () => {
    const manifests = await readWebhookManifests([path.join(FIXTURES, "deny-webhook.yaml")]);
    const [rewritten] = rewriteWebhookManifests(manifests, "127.0.0.1", 9443, CA_PEM);

    const hook = rewritten.webhooks![0];
    expect(hook.clientConfig!.url).toBe("https://127.0.0.1:9443/validate-deny");
    expect(hook.clientConfig!.service).toBeUndefined();
    expect(hook.clientConfig!.caBundle).toBe(Buffer.from(CA_PEM).toString("base64"));
    // Unrelated fields survive the rewrite.
    expect(hook.failurePolicy).toBe("Fail");
    expect(hook.objectSelector).toEqual({ matchLabels: { "envtest-webhook": "deny" } });
    // The input manifest is not mutated.
    expect(manifests[0].webhooks![0].clientConfig!.service).toBeDefined();
    expect(manifests[0].webhooks![0].clientConfig!.caBundle).toBeUndefined();
  });

  it("handles url-based clientConfigs and mutating configurations", () => {
    const manifest: WebhookConfigurationManifest = {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "MutatingWebhookConfiguration",
      metadata: { name: "mutate-things" },
      webhooks: [
        {
          name: "mutate.example.com",
          clientConfig: { url: "https://some-other-host:1234/mutate-path" },
        },
        { name: "no-client-config.example.com" },
      ],
    };
    const [rewritten] = rewriteWebhookManifests([manifest], "localhost", 8443, CA_PEM);
    expect(rewritten.webhooks![0].clientConfig!.url).toBe("https://localhost:8443/mutate-path");
    expect(rewritten.webhooks![1].clientConfig!.url).toBe("https://localhost:8443/");
  });

  it("brackets IPv6 serving hosts", () => {
    const manifest: WebhookConfigurationManifest = {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingWebhookConfiguration",
      metadata: { name: "v6" },
      webhooks: [{ name: "w.example.com", clientConfig: {} }],
    };
    const [rewritten] = rewriteWebhookManifests([manifest], "::1", 8443, CA_PEM);
    expect(rewritten.webhooks![0].clientConfig!.url).toBe("https://[::1]:8443/");
  });
});

describe("rewriteConversionWebhooks", () => {
  const conversionCRD: CRDConversionTarget = {
    kind: "CustomResourceDefinition",
    metadata: { name: "widgets.conversion.example.com" },
    spec: {
      group: "conversion.example.com",
      conversion: {
        strategy: "Webhook",
        webhook: {
          conversionReviewVersions: ["v1"],
          clientConfig: {
            service: { name: "webhook-service", namespace: "default", path: "/convert" },
          },
        },
      },
    },
  };

  it("rewrites CRDs declaring webhook conversion, without mutating the input", () => {
    const [rewritten] = rewriteConversionWebhooks([conversionCRD], "127.0.0.1", 9443, CA_PEM);
    const webhook = rewritten.spec!.conversion!.webhook!;
    expect(webhook.clientConfig!.url).toBe("https://127.0.0.1:9443/convert");
    expect(webhook.clientConfig!.service).toBeUndefined();
    expect(webhook.clientConfig!.caBundle).toBe(Buffer.from(CA_PEM).toString("base64"));
    // Authored conversionReviewVersions survive.
    expect(webhook.conversionReviewVersions).toEqual(["v1"]);
    // Input untouched.
    expect(conversionCRD.spec!.conversion!.webhook!.clientConfig!.service).toBeDefined();
  });

  it("defaults the path and review versions when the manifest omits them", () => {
    const bare: CRDConversionTarget = {
      kind: "CustomResourceDefinition",
      metadata: { name: "bare.example.com" },
      spec: { conversion: { strategy: "Webhook" } },
    };
    const [rewritten] = rewriteConversionWebhooks([bare], "localhost", 8443, CA_PEM);
    const webhook = rewritten.spec!.conversion!.webhook!;
    expect(webhook.clientConfig!.url).toBe("https://localhost:8443/convert");
    expect(webhook.conversionReviewVersions).toEqual(["v1", "v1beta1"]);
  });

  it("leaves CRDs without webhook conversion untouched", () => {
    const noConversion: CRDConversionTarget = {
      kind: "CustomResourceDefinition",
      metadata: { name: "plain.example.com" },
      spec: {},
    };
    const noneStrategy: CRDConversionTarget = {
      kind: "CustomResourceDefinition",
      metadata: { name: "none.example.com" },
      spec: { conversion: { strategy: "None" } },
    };
    const results = rewriteConversionWebhooks(
      [noConversion, noneStrategy],
      "127.0.0.1",
      9443,
      CA_PEM,
    );
    expect(results[0]).toBe(noConversion);
    expect(results[1]).toBe(noneStrategy);
  });
});
