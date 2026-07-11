import { ManagedProcess } from "./process.js";
import { connectHostFor, getFreePort, hostPort, retryOnBindFailure } from "./ports.js";
import { restRequest, type RestConfig } from "../client/rest.js";
import { mergeArgs, renderArgs, type ExtraArgs } from "./args.js";

export interface APIServerCertFiles {
  /** CA that signed the serving and client certs (--client-ca-file too). */
  caCert: string;
  servingCert: string;
  servingKey: string;
  /** RSA public key for --service-account-key-file. */
  saPublicKey: string;
  /** RSA private key for --service-account-signing-key-file. */
  saPrivateKey: string;
}

export interface APIServerOptions {
  binary: string;
  etcdURL: string;
  certDir: string;
  certFiles: APIServerCertFiles;
  /** Admin mTLS credentials used for the /readyz poll. */
  adminRestConfigFor: (server: string) => RestConfig;
  /**
   * Address to bind and serve on (upstream SecureServing.Address).
   * Default 127.0.0.1. The serving cert must cover it — TestEnvironment
   * appends non-loopback addresses to the SANs automatically.
   */
  listenAddress?: string;
  /** Fixed secure port (upstream SecurePort). Default: an OS-assigned free port. */
  securePort?: number;
  extraArgs?: ExtraArgs;
  /** Interval between readiness checks (default 150ms). */
  readyPollIntervalMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  attachOutput?: boolean;
}

/**
 * Manages kube-apiserver with the same default flag set as
 * controller-runtime's envtest (secure serving only, RBAC authorization,
 * client-cert auth against a throwaway CA, real service-account signing).
 */
export class APIServer {
  private process: ManagedProcess | undefined;
  /** e.g. https://127.0.0.1:56789 — available after start(). */
  url = "";
  port = 0;

  constructor(private readonly opts: APIServerOptions) {}

  async start(): Promise<void> {
    if (this.opts.securePort !== undefined) {
      // A caller-fixed port leaves nothing to re-pick: fail immediately.
      await this.startAttempt();
      return;
    }
    // Retried with a fresh port if another process wins the bind race.
    await retryOnBindFailure(() => this.startAttempt());
  }

  private async startAttempt(): Promise<void> {
    const listenAddress = this.opts.listenAddress ?? "127.0.0.1";
    this.port = this.opts.securePort ?? (await getFreePort(listenAddress));
    // Clients (readiness poll, kubeconfig) dial the connect host — loopback
    // for wildcard binds, the address itself otherwise.
    this.url = `https://${hostPort(connectHostFor(listenAddress), this.port)}`;
    const { certFiles } = this.opts;

    const defaults: Record<string, string> = {
      "advertise-address": "127.0.0.1",
      "bind-address": listenAddress,
      "secure-port": String(this.port),
      "etcd-servers": this.opts.etcdURL,
      "cert-dir": this.opts.certDir,
      "tls-cert-file": certFiles.servingCert,
      "tls-private-key-file": certFiles.servingKey,
      "client-ca-file": certFiles.caCert,
      "service-account-issuer": `${this.url}/`,
      "service-account-key-file": certFiles.saPublicKey,
      "service-account-signing-key-file": certFiles.saPrivateKey,
      "authorization-mode": "RBAC",
      "service-cluster-ip-range": "10.0.0.0/24",
      "allow-privileged": "true",
      // Kept disabled upstream too: the controller that creates the default
      // ServiceAccount doesn't run in envtest, so the admission plugin would
      // reject most pod creation.
      "disable-admission-plugins": "ServiceAccount",
    };

    const restConfig = this.opts.adminRestConfigFor(this.url);
    this.process = new ManagedProcess({
      name: "kube-apiserver",
      command: this.opts.binary,
      args: renderArgs(mergeArgs(defaults, this.opts.extraArgs)),
      readyCheck: async () => {
        const res = await restRequest(restConfig, "GET", "/readyz");
        return res.status === 200;
      },
      readyPollIntervalMs: this.opts.readyPollIntervalMs,
      startTimeoutMs: this.opts.startTimeoutMs,
      stopTimeoutMs: this.opts.stopTimeoutMs,
      attachOutput: this.opts.attachOutput,
    });
    await this.process.start();
  }

  async stop(): Promise<void> {
    await this.process?.stop();
  }
}
