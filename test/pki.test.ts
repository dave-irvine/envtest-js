import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import { TinyCA, generateServiceAccountKeys } from "../src/controlplane/pki.js";

const SERVER_AUTH = /serverAuth|Server Authentication|1\.3\.6\.1\.5\.5\.7\.3\.1/;
const CLIENT_AUTH = /clientAuth|Client Authentication|1\.3\.6\.1\.5\.5\.7\.3\.2/;

describe("TinyCA", () => {
  it("creates a self-signed CA certificate", async () => {
    const ca = await TinyCA.create();
    const cert = new X509Certificate(ca.certificatePem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain("CN=envtest-environment-ca");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it("mints serving certs with DNS and IP SANs, chained to the CA", async () => {
    const ca = await TinyCA.create();
    const caCert = new X509Certificate(ca.certificatePem);
    const serving = await ca.newServingCert(
      "localhost",
      "127.0.0.1",
      "::1",
      "kubernetes.default.svc",
    );
    const cert = new X509Certificate(serving.certPem);

    // Issuance proof: cryptographic (signature verifies against the CA key)
    // plus the issuer/subject chain. (Node's checkIssued() would also work,
    // but Bun returns a certificate object from it instead of a boolean.)
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.issuer).toBe(caCert.subject);
    expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.subjectAltName).toContain("DNS:kubernetes.default.svc");
    expect(String(cert.keyUsage)).toMatch(SERVER_AUTH);
    // The private key must pair with the certificate.
    expect(cert.checkPrivateKey(createPrivateKey(serving.keyPem))).toBe(true);
  });

  it("mints client certs with CN=user and O=groups (Kubernetes identity mapping)", async () => {
    const ca = await TinyCA.create();
    const caCert = new X509Certificate(ca.certificatePem);
    const admin = await ca.newClientCert("envtest-admin", ["system:masters"]);
    const cert = new X509Certificate(admin.certPem);

    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.subject).toContain("CN=envtest-admin");
    expect(cert.subject).toContain("O=system:masters");
    expect(String(cert.keyUsage)).toMatch(CLIENT_AUTH);
    expect(cert.checkPrivateKey(createPrivateKey(admin.keyPem))).toBe(true);
  });

  // Upstream tinyca_test: "should produce unique serials among all
  // generated certificates of all types".
  it("produces unique serials across all generated certificates", async () => {
    const ca = await TinyCA.create();
    const certs = [
      ca.certificatePem,
      (await ca.newServingCert()).certPem,
      (await ca.newServingCert()).certPem,
      (await ca.newClientCert("a")).certPem,
      (await ca.newClientCert("b", ["g"])).certPem,
    ];
    const serials = certs.map((pem) => new X509Certificate(pem).serialNumber);
    expect(new Set(serials).size).toBe(serials.length);
  });

  // Upstream tinyca_test: "valid for short enough to avoid production usage,
  // but long enough for long-running tests" (applies to serving and client).
  it("issues certs valid for days, not years", async () => {
    const ca = await TinyCA.create();
    for (const pem of [
      (await ca.newServingCert()).certPem,
      (await ca.newClientCert("u")).certPem,
    ]) {
      const cert = new X509Certificate(pem);
      const windowMs = new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime();
      expect(windowMs).toBeGreaterThan(24 * 60 * 60 * 1000); // > 1 day
      expect(windowMs).toBeLessThan(14 * 24 * 60 * 60 * 1000); // < 2 weeks
    }
  });

  // Upstream tinyca_test: DNS serving names are resolved and their addresses
  // added as IP SANs alongside the DNS SAN.
  it("resolves DNS serving names and adds their IPs as IP SANs", async () => {
    const ca = await TinyCA.create();
    const cert = new X509Certificate((await ca.newServingCert("localhost")).certPem);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    // localhost resolves via the hosts file everywhere, to 127.0.0.1 and/or ::1.
    expect(cert.subjectAltName).toMatch(/IP Address:(127\.0\.0\.1|::1)/);
  });

  // Divergence from upstream (which fails hard on resolution errors): the
  // default apiserver SAN set includes in-cluster names that never resolve
  // on the host, so unresolvable names stay DNS-only.
  it("keeps unresolvable DNS names as DNS SANs without failing", async () => {
    const ca = await TinyCA.create();
    const serving = await ca.newServingCert("kubernetes.default.svc.cluster.local", "127.0.0.1");
    const cert = new X509Certificate(serving.certPem);
    expect(cert.subjectAltName).toContain("DNS:kubernetes.default.svc.cluster.local");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  it("does not duplicate SANs when a name and its address are both given", async () => {
    const ca = await TinyCA.create();
    const serving = await ca.newServingCert("localhost", "127.0.0.1", "::1", "127.0.0.1");
    const entries = new X509Certificate(serving.certPem).subjectAltName!.split(", ");
    expect(new Set(entries).size).toBe(entries.length);
  });

  // Upstream tinyca_test: "should ignore empty names".
  it("skips empty serving-cert names", async () => {
    const ca = await TinyCA.create();
    const serving = await ca.newServingCert("", "localhost");
    const cert = new X509Certificate(serving.certPem);
    expect(cert.subject).toContain("CN=localhost");
    expect(cert.subjectAltName!.split(", ")).not.toContain("DNS:");
  });

  // Upstream tinyca_test: "should assume a name of localhost if no names are given".
  it("defaults serving certs to localhost/loopback when no names are given", async () => {
    const ca = await TinyCA.create();
    const cert = new X509Certificate((await ca.newServingCert()).certPem);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  it("certs from different CAs do not cross-verify", async () => {
    const ca1 = await TinyCA.create();
    const ca2 = await TinyCA.create();
    const cert = new X509Certificate((await ca1.newClientCert("u")).certPem);
    const otherCA = new X509Certificate(ca2.certificatePem);
    expect(cert.verify(otherCA.publicKey)).toBe(false);
  });
});

describe("generateServiceAccountKeys", () => {
  it("produces a matching RSA PKCS#8/SPKI PEM pair", async () => {
    const keys = await generateServiceAccountKeys();
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    const derived = createPublicKey(keys.privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
    expect(derived.trim()).toBe(keys.publicKeyPem.trim());
  });
});
