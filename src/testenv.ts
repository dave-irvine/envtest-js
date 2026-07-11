import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { APIServer, type APIServerCertFiles } from "./controlplane/apiserver.js";
import { resolveBinaries, type BinaryPaths, type ResolveBinariesOptions } from "./setup/assets.js";
import {
  installCRDs,
  uninstallCRDs,
  type CRDManifest,
  type InstallCRDsOptions,
} from "./client/crd.js";
import { Etcd } from "./controlplane/etcd.js";
import { buildKubeconfig } from "./client/kubeconfig.js";
import { generateServiceAccountKeys, TinyCA } from "./controlplane/pki.js";
import { getFreePort } from "./controlplane/ports.js";
import { type RestConfig } from "./client/rest.js";
import { type ExtraArgs } from "./controlplane/args.js";
import {
  installWebhooks,
  readWebhookManifests,
  rewriteWebhookManifests,
  waitForWebhookServer,
  type WebhookConfigurationManifest,
  type WebhookInstallOptions,
} from "./client/webhook.js";

/** SANs on the apiserver serving certificate, matching upstream envtest. */
const API_SERVER_CERT_NAMES = [
  "localhost",
  "127.0.0.1",
  "::1",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
];

const ADMIN_USER = "envtest-admin";
const ADMIN_GROUPS = ["system:masters"];

const b64 = (pem: string) => Buffer.from(pem).toString("base64");

export interface TestEnvironmentOptions extends ResolveBinariesOptions {
  /** CRD manifests (files or directories) to install after startup. */
  crdDirectoryPaths?: string[];
  /**
   * In-memory CRD manifests to install after startup, alongside (before)
   * those from crdDirectoryPaths (upstream: Environment.CRDs).
   */
  crds?: CRDManifest[];
  /**
   * Address the apiserver binds and serves on (upstream
   * SecureServing.Address). Defaults to 127.0.0.1 — the safe, hermetic
   * choice. A non-loopback address (e.g. a Docker bridge IP so containers
   * can reach the host's apiserver) is automatically added to the serving
   * cert's SANs, and the kubeconfig/server URL points at it, so remote
   * clients pass TLS verification. Wildcard binds (0.0.0.0/::) listen on
   * all interfaces, but only loopback names land in the SANs — remote
   * clients of a wildcard bind will fail TLS verification unless they
   * connect via an address in the SAN set.
   */
  listenAddress?: string;
  /** Fixed apiserver port (upstream SecurePort). Default: an OS-assigned free port. */
  securePort?: number;
  /** Extra/overriding kube-apiserver flags; null removes a default. */
  apiServerFlags?: ExtraArgs;
  /** Extra/overriding etcd flags; null removes a default. */
  etcdFlags?: ExtraArgs;
  /**
   * Interval between etcd/apiserver readiness checks while starting
   * (upstream: HealthCheck.PollInterval). Default 150ms.
   */
  readyPollIntervalMs?: number;
  /** Per-process readiness timeout (default 60s). */
  startTimeoutMs?: number;
  /** Graceful-shutdown timeout before SIGKILL (default 10s). */
  stopTimeoutMs?: number;
  /** Pipe etcd/kube-apiserver output to stderr for debugging. */
  attachOutput?: boolean;
  crdInstallOptions?: InstallCRDsOptions;
  /** Install admission webhooks that call back into the test process. */
  webhookInstallOptions?: WebhookInstallOptions;
}

/** Serving details for the in-test webhook server, available on the config. */
export interface WebhookServing {
  /** Address the webhook configurations point at — listen here. */
  host: string;
  port: number;
  /** PEM CA injected as caBundle (signs the serving cert below). */
  caPem: string;
  /** PEM serving certificate/key for the test's HTTPS server. */
  certPem: string;
  keyPem: string;
  /** Directory containing tls.crt / tls.key (controller-runtime CertDir convention). */
  certDir: string;
  certPath: string;
  keyPath: string;
  /** Names of the installed webhook configurations. */
  configurationNames: string[];
}

/** An identity to provision with addUser() (upstream: envtest.User). */
export interface User {
  /** Username, mapped from the client certificate's CN. */
  name: string;
  /** Group memberships, mapped from the certificate's O values. */
  groups?: string[];
}

/**
 * Credentials for a user provisioned via addUser() (upstream:
 * envtest.AuthenticatedUser): ready-to-use REST config plus a kubectl-ready
 * kubeconfig written into the environment's temp dir.
 */
export interface AuthenticatedUser extends RestConfig {
  user: string;
  groups: string[];
  /** Base64 of caPem/certPem/keyPem — the kubeconfig data field encoding. */
  caData: string;
  certData: string;
  keyData: string;
  kubeconfigPath: string;
  kubeconfigYaml: string;
}

export interface EnvtestConfig extends RestConfig {
  /** Base64 of caPem/certPem/keyPem — the kubeconfig data field encoding. */
  caData: string;
  certData: string;
  keyData: string;
  /** Path of a ready-to-use kubeconfig file (written into the env's temp dir). */
  kubeconfigPath: string;
  kubeconfigYaml: string;
  user: string;
  etcdURL: string;
  apiServerPort: number;
  binaries: BinaryPaths;
  /** Names of CRDs installed at startup. */
  installedCRDs: string[];
  /** Present when the environment was started with webhookInstallOptions. */
  webhook?: WebhookServing;
}

/**
 * A local Kubernetes control plane (etcd + kube-apiserver) for integration
 * tests — a TypeScript port of controller-runtime's envtest.Environment.
 *
 * Full-fidelity PKI: a throwaway CA signs the apiserver's serving cert and
 * an admin client cert (CN=envtest-admin, O=system:masters); an RSA keypair
 * signs real service-account tokens. No insecure-skip-tls-verify anywhere.
 */
export class TestEnvironment {
  private etcd: Etcd | undefined;
  private apiServer: APIServer | undefined;
  private workDir: string | undefined;
  private _config: EnvtestConfig | undefined;
  /** Kept after start() so addUser() can mint further client certs. */
  private ca: TinyCA | undefined;
  private userKubeconfigNames = new Set<string>();

  constructor(private readonly options: TestEnvironmentOptions = {}) {}

  /** Available after start(). */
  get config(): EnvtestConfig {
    if (!this._config) throw new Error("TestEnvironment not started");
    return this._config;
  }

  async start(): Promise<EnvtestConfig> {
    if (this._config) throw new Error("TestEnvironment already started");
    const opts = this.options;

    const binaries = await resolveBinaries(opts);

    this.workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-"));
    const certDir = path.join(this.workDir, "certs");
    const etcdDataDir = path.join(this.workDir, "etcd-data");
    await fsp.mkdir(certDir, { recursive: true });
    await fsp.mkdir(etcdDataDir, { recursive: true });

    try {
      // --- PKI ---
      // A custom listen address must land in the serving cert's SANs, or
      // clients dialing it fail TLS verification (upstream appends the
      // configured address the same way). Wildcards aren't dialable
      // addresses, and the loopback names are already in the default set.
      const listenAddress = opts.listenAddress ?? "127.0.0.1";
      const servingNames = [...API_SERVER_CERT_NAMES];
      if (!["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(listenAddress)) {
        servingNames.push(listenAddress);
      }
      const ca = await TinyCA.create();
      this.ca = ca;
      const serving = await ca.newServingCert(...servingNames);
      const admin = await ca.newClientCert(ADMIN_USER, ADMIN_GROUPS);
      const saKeys = await generateServiceAccountKeys();

      const certFiles: APIServerCertFiles = {
        caCert: path.join(certDir, "ca.crt"),
        servingCert: path.join(certDir, "apiserver.crt"),
        servingKey: path.join(certDir, "apiserver.key"),
        saPublicKey: path.join(certDir, "sa-signer.pub"),
        saPrivateKey: path.join(certDir, "sa-signer.key"),
      };
      // Private keys are owner-only; certificates are public material.
      // (The mkdtemp workdir is already 0700 on POSIX — defense in depth.)
      const PRIVATE = { mode: 0o600 } as const;
      await Promise.all([
        fsp.writeFile(certFiles.caCert, ca.certificatePem),
        fsp.writeFile(certFiles.servingCert, serving.certPem),
        fsp.writeFile(certFiles.servingKey, serving.keyPem, PRIVATE),
        fsp.writeFile(certFiles.saPublicKey, saKeys.publicKeyPem),
        fsp.writeFile(certFiles.saPrivateKey, saKeys.privateKeyPem, PRIVATE),
        fsp.writeFile(path.join(certDir, "admin.crt"), admin.certPem),
        fsp.writeFile(path.join(certDir, "admin.key"), admin.keyPem, PRIVATE),
      ]);

      // --- webhook prep (cert, port, manifest rewrite) ---
      // Like upstream's PrepWithoutInstalling: a *separate* throwaway CA
      // signs the webhook serving cert, so trust flows only through the
      // caBundle we inject — never the cluster CA.
      let webhookPrep:
        | { serving: WebhookServing; manifests: WebhookConfigurationManifest[] }
        | undefined;
      if (opts.webhookInstallOptions) {
        const webhookOpts = opts.webhookInstallOptions;
        const host = webhookOpts.localServingHost ?? "127.0.0.1";
        const port = webhookOpts.localServingPort ?? (await getFreePort(host));
        const webhookCA = await TinyCA.create("envtest-webhook-ca");
        const names = [...new Set(["localhost", "127.0.0.1", "::1", host])];
        const serving = await webhookCA.newServingCert(...names);

        const webhookCertDir = path.join(this.workDir, "webhook-certs");
        await fsp.mkdir(webhookCertDir);
        const certPath = path.join(webhookCertDir, "tls.crt");
        const keyPath = path.join(webhookCertDir, "tls.key");
        await Promise.all([
          fsp.writeFile(certPath, serving.certPem),
          fsp.writeFile(keyPath, serving.keyPem, { mode: 0o600 }),
        ]);

        const manifests = rewriteWebhookManifests(
          await readWebhookManifests(webhookOpts.paths),
          host,
          port,
          webhookCA.certificatePem,
        );
        webhookPrep = {
          manifests,
          serving: {
            host,
            port,
            caPem: webhookCA.certificatePem,
            certPem: serving.certPem,
            keyPem: serving.keyPem,
            certDir: webhookCertDir,
            certPath,
            keyPath,
            configurationNames: [],
          },
        };
      }

      // --- etcd ---
      this.etcd = new Etcd({
        binary: binaries.etcd,
        dataDir: etcdDataDir,
        extraArgs: opts.etcdFlags,
        readyPollIntervalMs: opts.readyPollIntervalMs,
        startTimeoutMs: opts.startTimeoutMs,
        stopTimeoutMs: opts.stopTimeoutMs,
        attachOutput: opts.attachOutput,
      });
      await this.etcd.start();

      // --- kube-apiserver ---
      this.apiServer = new APIServer({
        binary: binaries.kubeApiserver,
        etcdURL: this.etcd.url,
        certDir,
        certFiles,
        listenAddress: opts.listenAddress,
        securePort: opts.securePort,
        adminRestConfigFor: (server) => ({
          server,
          caPem: ca.certificatePem,
          certPem: admin.certPem,
          keyPem: admin.keyPem,
        }),
        extraArgs: opts.apiServerFlags,
        readyPollIntervalMs: opts.readyPollIntervalMs,
        startTimeoutMs: opts.startTimeoutMs,
        stopTimeoutMs: opts.stopTimeoutMs,
        attachOutput: opts.attachOutput,
      });
      await this.apiServer.start();

      const restConfig: RestConfig = {
        server: this.apiServer.url,
        caPem: ca.certificatePem,
        certPem: admin.certPem,
        keyPem: admin.keyPem,
      };

      // --- webhooks (before CRDs, as upstream does) ---
      let webhook: WebhookServing | undefined;
      if (webhookPrep) {
        webhookPrep.serving.configurationNames = await installWebhooks(
          restConfig,
          webhookPrep.manifests,
        );
        webhook = webhookPrep.serving;
      }

      // --- kubeconfig ---
      const kubeconfigYaml = buildKubeconfig({
        server: this.apiServer.url,
        caPem: ca.certificatePem,
        clientCertPem: admin.certPem,
        clientKeyPem: admin.keyPem,
        userName: ADMIN_USER,
      });
      const kubeconfigPath = path.join(this.workDir, "kubeconfig");
      // The kubeconfig inlines the admin client key: owner-only.
      await fsp.writeFile(kubeconfigPath, kubeconfigYaml, { mode: 0o600 });

      // --- CRDs ---
      let installedCRDs: string[] = [];
      const crdObjects = [...(opts.crds ?? []), ...(opts.crdInstallOptions?.crds ?? [])];
      if (opts.crdDirectoryPaths?.length || crdObjects.length) {
        installedCRDs = await installCRDs(restConfig, opts.crdDirectoryPaths ?? [], {
          ...opts.crdInstallOptions,
          crds: crdObjects,
          conversionWebhook:
            opts.crdInstallOptions?.conversionWebhook ?? this.conversionWebhookFor(webhook),
        });
      }

      this._config = {
        ...restConfig,
        caData: b64(restConfig.caPem),
        certData: b64(restConfig.certPem),
        keyData: b64(restConfig.keyPem),
        kubeconfigPath,
        kubeconfigYaml,
        user: ADMIN_USER,
        etcdURL: this.etcd.url,
        apiServerPort: this.apiServer.port,
        binaries,
        installedCRDs,
        webhook,
      };
      return this._config;
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }
  }

  private conversionWebhookFor(
    webhook: WebhookServing | undefined,
  ): InstallCRDsOptions["conversionWebhook"] {
    return webhook && { host: webhook.host, port: webhook.port, caPem: webhook.caPem };
  }

  /**
   * Provision an additional user recognized by the running apiserver
   * (upstream: Environment.AddUser). The environment's CA signs a client
   * cert with CN=name / O=groups, so the identity authenticates immediately
   * — pair it with RBAC objects to test access as a non-admin.
   */
  async addUser(user: User): Promise<AuthenticatedUser> {
    const config = this.config; // throws when not started
    if (!user.name) throw new Error("user name is required");
    if (!this.ca || !this.workDir) throw new Error("TestEnvironment not started");

    // Copy, not adopt: the same array goes into the cert's O= values and the
    // returned object — later caller mutation must affect neither.
    const groups = [...(user.groups ?? [])];
    const { certPem, keyPem } = await this.ca.newClientCert(user.name, groups);
    const kubeconfigYaml = buildKubeconfig({
      server: config.server,
      caPem: config.caPem,
      clientCertPem: certPem,
      clientKeyPem: keyPem,
      userName: user.name,
    });
    const kubeconfigPath = path.join(this.workDir, this.userKubeconfigName(user.name));
    // Like the admin kubeconfig, this inlines the client key: owner-only.
    await fsp.writeFile(kubeconfigPath, kubeconfigYaml, { mode: 0o600 });

    return {
      server: config.server,
      caPem: config.caPem,
      certPem,
      keyPem,
      caData: config.caData,
      certData: b64(certPem),
      keyData: b64(keyPem),
      kubeconfigPath,
      kubeconfigYaml,
      user: user.name,
      groups,
    };
  }

  /**
   * Usernames may contain characters that are invalid in filenames (":" in
   * system:* names is forbidden on Windows), and distinct names can collide
   * once sanitized — so dedupe with a counter suffix.
   */
  private userKubeconfigName(userName: string): string {
    const safe = userName.replace(/[^A-Za-z0-9._-]/g, "-");
    let name = `kubeconfig-${safe}`;
    for (let i = 2; this.userKubeconfigNames.has(name); i++) name = `kubeconfig-${safe}-${i}`;
    this.userKubeconfigNames.add(name);
    return name;
  }

  /** Install additional CRDs into a running environment. */
  async installCRDs(paths: string[], opts?: InstallCRDsOptions): Promise<string[]> {
    return installCRDs(this.config, paths, {
      ...opts,
      conversionWebhook:
        opts?.conversionWebhook ?? this.conversionWebhookFor(this.config.webhook),
    });
  }

  /** Delete the CRDs named by the given manifests from the running environment. */
  async uninstallCRDs(
    paths: string[],
    opts?: Pick<InstallCRDsOptions, "crds" | "errorIfPathMissing">,
  ): Promise<string[]> {
    return uninstallCRDs(this.config, paths, opts);
  }

  /**
   * Wait until the test's webhook server accepts TLS connections on the
   * local serving address, verifying it serves a certificate the apiserver
   * will trust. Call after starting your HTTPS server (with config.webhook
   * cert/key), before exercising requests that trigger it.
   */
  async waitForWebhookServer(timeoutMs?: number): Promise<void> {
    const webhook = this.config.webhook;
    if (!webhook) {
      throw new Error("environment was started without webhookInstallOptions");
    }
    await waitForWebhookServer(webhook.host, webhook.port, { timeoutMs, caPem: webhook.caPem });
  }

  /** Tear down the control plane and delete all temporary state. */
  async stop(): Promise<void> {
    // Reverse startup order: apiserver first so etcd doesn't vanish under it.
    await this.apiServer?.stop();
    await this.etcd?.stop();
    this.apiServer = undefined;
    this.etcd = undefined;
    this._config = undefined;
    this.ca = undefined;
    this.userKubeconfigNames.clear();
    if (this.workDir) {
      // etcd on Windows can hold file locks for a beat after exit.
      await fsp
        .rm(this.workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .catch(() => {});
      this.workDir = undefined;
    }
  }
}
