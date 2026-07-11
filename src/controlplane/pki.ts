// Must precede @peculiar/x509: since v2 it wires itself with tsyringe, which
// needs the reflect-metadata polyfill loaded first (v1 bundled it).
import "reflect-metadata";
import { generateKeyPair, randomBytes, webcrypto } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import * as x509 from "@peculiar/x509";

const generateKeyPairAsync = promisify(generateKeyPair);

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

// @peculiar/x509 auto-detects globalThis.crypto (always present on Node >= 19
// and Bun), so no cryptoProvider.set() call is needed. `webcrypto` here is
// that same object, imported for its namespaced types.

const KEY_ALG: webcrypto.EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGNING_ALG: webcrypto.EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

// Throwaway certs: valid from 5 minutes ago (clock skew) for one week,
// matching the spirit of controller-runtime's tinyca.
const VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const SKEW_MS = 5 * 60 * 1000;

export interface CertKeyPair {
  /** PEM-encoded certificate. */
  certPem: string;
  /** PEM-encoded PKCS#8 private key. */
  keyPem: string;
}

export interface ServiceAccountKeys {
  /** PEM PKCS#8 RSA private key, for --service-account-signing-key-file. */
  privateKeyPem: string;
  /** PEM SPKI public key, for --service-account-key-file. */
  publicKeyPem: string;
}

function validity(): { notBefore: Date; notAfter: Date } {
  const now = Date.now();
  return { notBefore: new Date(now - SKEW_MS), notAfter: new Date(now + VALIDITY_MS) };
}

function randomSerial(): string {
  const buf = randomBytes(10);
  buf[0] &= 0x7f; // keep the integer positive
  return buf.toString("hex");
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey("pkcs8", key);
  return x509.PemConverter.encode(der, "PRIVATE KEY");
}

/**
 * A minimal throwaway certificate authority, equivalent to controller-runtime's
 * internal "tinyca": one self-signed CA that can mint serving and client certs.
 */
export class TinyCA {
  private constructor(
    readonly certificate: x509.X509Certificate,
    private readonly keys: CryptoKeyPair,
  ) {}

  static async create(commonName = "envtest-environment-ca"): Promise<TinyCA> {
    const keys = (await webcrypto.subtle.generateKey(KEY_ALG, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const { notBefore, notAfter } = validity();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: `CN=${commonName}`,
      notBefore,
      notAfter,
      signingAlgorithm: SIGNING_ALG,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature |
            x509.KeyUsageFlags.keyCertSign |
            x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    return new TinyCA(cert, keys);
  }

  get certificatePem(): string {
    return this.certificate.toString("pem");
  }

  private async issue(
    subject: x509.Name,
    extraExtensions: x509.Extension[],
  ): Promise<CertKeyPair> {
    const keys = (await webcrypto.subtle.generateKey(KEY_ALG, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const { notBefore, notAfter } = validity();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject,
      issuer: this.certificate.subject,
      notBefore,
      notAfter,
      signingAlgorithm: SIGNING_ALG,
      publicKey: keys.publicKey,
      signingKey: this.keys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate),
        ...extraExtensions,
      ],
    });
    return { certPem: cert.toString("pem"), keyPem: await exportPrivateKeyPem(keys.privateKey) };
  }

  /**
   * Mint a TLS serving certificate. Names may be DNS names or IP addresses;
   * they land in the SAN extension. Empty names are skipped, and DNS names
   * are additionally resolved so their addresses become IP SANs, both as
   * upstream's tinyca does — except that upstream fails on resolution errors
   * while we skip them, because our default apiserver SAN set includes
   * in-cluster names (kubernetes.default.svc, ...) that never resolve on the
   * host. Defaults to localhost + loopback.
   */
  async newServingCert(...names: string[]): Promise<CertKeyPair> {
    names = names.filter((n) => n !== "");
    if (names.length === 0) names = ["localhost", "127.0.0.1", "::1"];
    const dnsNames = [...new Set(names.filter((n) => !isIP(n)))];
    const resolved = await Promise.all(
      dnsNames.map((n) =>
        lookup(n, { all: true }).then(
          (addrs) => addrs.map((a) => a.address),
          () => [],
        ),
      ),
    );
    const ips = [...new Set([...names.filter((n) => isIP(n)), ...resolved.flat()])];
    const sans = [
      ...dnsNames.map((n) => new x509.GeneralName("dns", n)),
      ...ips.map((ip) => new x509.GeneralName("ip", ip)),
    ];
    return this.issue(new x509.Name(`CN=${names[0]}`), [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(sans, false),
    ]);
  }

  /**
   * Mint a client certificate for a user. Kubernetes maps the certificate
   * CN to the username and each O to a group — this is how the envtest admin
   * identity (groups: system:masters) is created.
   */
  async newClientCert(userName: string, groups: string[] = []): Promise<CertKeyPair> {
    const rdns: Record<string, string[]>[] = [];
    if (groups.length > 0) rdns.push({ O: groups });
    rdns.push({ CN: [userName] });
    return this.issue(new x509.Name(rdns), [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
    ]);
  }
}

/**
 * RSA keypair for service-account token signing
 * (--service-account-signing-key-file / --service-account-key-file).
 */
export async function generateServiceAccountKeys(): Promise<ServiceAccountKeys> {
  const { privateKey, publicKey } = await generateKeyPairAsync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}
