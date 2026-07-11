import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";

const MAX_CAPTURED_OUTPUT = 128 * 1024;

function spawnServer(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  stopTimeoutMs: number,
) {
  return execa(command, args, {
    env,
    // Long-running server: keep our own bounded capture instead of execa's
    // unbounded buffering (whose maxBuffer would kill the process).
    buffer: false,
    // Exits are surfaced through `settled`, never as promise rejections.
    reject: false,
    cleanup: true,
    // SIGTERM -> SIGKILL escalation when kill() is called.
    forceKillAfterDelay: stopTimeoutMs,
    stdin: "ignore",
    windowsHide: true,
  } as const);
}

type Subprocess = ReturnType<typeof spawnServer>;

export interface ManagedProcessOptions {
  /** Human-readable name used in error messages. */
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Returns true once the process is serving. Errors are treated as "not ready yet". */
  readyCheck: () => Promise<boolean>;
  /**
   * Interval between ready checks (upstream: HealthCheck.PollInterval).
   * Default 150ms.
   */
  readyPollIntervalMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Pipe child stdout/stderr through to the parent (for debugging). */
  attachOutput?: boolean;
}

/**
 * A spawned control-plane process with readiness polling, captured output
 * for error reporting, and forceful teardown.
 *
 * Built on execa, which gives us zombie defence for free: `cleanup: true`
 * kills the child when the parent exits — including deaths by SIGINT/SIGTERM,
 * which a plain `process.on("exit")` hook would miss.
 */
export class ManagedProcess {
  private subprocess: Subprocess | undefined;
  private output = "";
  private hasExited = false;
  private settled: Promise<{ exitCode?: number; signal?: string; shortMessage?: string }> | undefined;

  constructor(private readonly opts: ManagedProcessOptions) {
    const interval = opts.readyPollIntervalMs ?? 150;
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error(`readyPollIntervalMs must be a positive number, got ${interval}`);
    }
  }

  get pid(): number | undefined {
    return this.subprocess?.pid;
  }

  /** Captured stdout+stderr (most recent ~128KB). */
  get capturedOutput(): string {
    return this.output;
  }

  async start(): Promise<void> {
    if (this.subprocess) throw new Error(`${this.opts.name} already started`);

    const subprocess = spawnServer(
      this.opts.command,
      this.opts.args,
      this.opts.env,
      this.opts.stopTimeoutMs ?? 10_000,
    );
    this.subprocess = subprocess;

    const capture = (chunk: Buffer) => {
      this.output += chunk.toString();
      if (this.output.length > MAX_CAPTURED_OUTPUT) {
        this.output = this.output.slice(-MAX_CAPTURED_OUTPUT);
      }
      if (this.opts.attachOutput) process.stderr.write(chunk);
    };
    subprocess.stdout?.on("data", capture);
    subprocess.stderr?.on("data", capture);

    // With reject: false, spawn failures (e.g. ENOENT) also settle here,
    // carrying a descriptive shortMessage.
    this.settled = subprocess.then((result) => {
      this.hasExited = true;
      return result as typeof result & { shortMessage?: string };
    });

    const timeoutMs = this.opts.startTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.hasExited) {
        const result = await this.settled;
        const reason =
          result.shortMessage ?? `exit code ${result.exitCode}, signal ${result.signal}`;
        throw new Error(
          `${this.opts.name} exited before becoming ready (${reason}). Output:\n${this.output}`,
        );
      }
      if (await this.opts.readyCheck().catch(() => false)) return;
      if (Date.now() > deadline) {
        await this.stop().catch(() => {});
        throw new Error(
          `${this.opts.name} did not become ready within ${timeoutMs}ms. Output:\n${this.output}`,
        );
      }
      await sleep(this.opts.readyPollIntervalMs ?? 150);
    }
  }

  async stop(): Promise<void> {
    if (!this.subprocess || this.hasExited) return;
    // Escalates to SIGKILL after forceKillAfterDelay if the process lingers.
    this.subprocess.kill("SIGTERM");
    await this.settled;
  }
}
