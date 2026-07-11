import { ManagedProcess } from "./process.js";
import { getFreePort, retryOnBindFailure } from "./ports.js";
import { mergeArgs, renderArgs, type ExtraArgs } from "./args.js";

export interface EtcdOptions {
  binary: string;
  dataDir: string;
  /** Extra/overriding etcd flags. A null value removes a default flag. */
  extraArgs?: ExtraArgs;
  /** Interval between readiness checks (default 150ms). */
  readyPollIntervalMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  attachOutput?: boolean;
}

/** Manages a single-member etcd, mirroring controller-runtime's etcd wrapper. */
export class Etcd {
  private process: ManagedProcess | undefined;
  /** Client URL, available after start(). */
  url = "";
  port = 0;

  constructor(private readonly opts: EtcdOptions) {}

  async start(): Promise<void> {
    // Retried with a fresh port if another process wins the bind race.
    await retryOnBindFailure(() => this.startAttempt());
  }

  private async startAttempt(): Promise<void> {
    // etcd is always loopback-only, as upstream: only the co-located
    // apiserver talks to it, so there is no listen-address option.
    const host = "127.0.0.1";
    this.port = await getFreePort(host);
    this.url = `http://${host}:${this.port}`;

    const defaults: Record<string, string> = {
      // Same defaults as controller-runtime's etcd wrapper: a throwaway
      // single member with an OS-assigned peer port and fsync disabled for
      // speed (safe for ephemeral test data).
      "data-dir": this.opts.dataDir,
      "listen-client-urls": this.url,
      "advertise-client-urls": this.url,
      "listen-peer-urls": "http://localhost:0",
      "unsafe-no-fsync": "true",
    };

    this.process = new ManagedProcess({
      name: "etcd",
      command: this.opts.binary,
      args: renderArgs(mergeArgs(defaults, this.opts.extraArgs)),
      readyCheck: () => this.isHealthy(),
      readyPollIntervalMs: this.opts.readyPollIntervalMs,
      startTimeoutMs: this.opts.startTimeoutMs,
      stopTimeoutMs: this.opts.stopTimeoutMs,
      attachOutput: this.opts.attachOutput,
    });
    await this.process.start();
  }

  private async isHealthy(): Promise<boolean> {
    const res = await fetch(`${this.url}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { health?: string };
    return body.health === "true";
  }

  async stop(): Promise<void> {
    await this.process?.stop();
  }
}
