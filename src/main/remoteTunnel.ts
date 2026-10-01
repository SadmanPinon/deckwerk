import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A short-lived public link to a local port, through Cloudflare's free quick
 * tunnels (`cloudflared tunnel --url`). It lets a remote-agent session be
 * reached from a server or cluster that cannot reach this machine, for exactly
 * as long as the session runs: closing it, or this app exiting in any way,
 * ends `cloudflared` and the link with it. The session behind it answers only
 * requests that carry its token.
 */

export interface QuickTunnel {
  url: string;
  /** Resolves once cloudflared has exited, for whatever reason. */
  exited: Promise<void>;
  close(): void;
}

const KNOWN_LOCATIONS = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];

/** cloudflared, from PATH or where Homebrew puts it (an app started from the Dock has a bare PATH). */
export function findCloudflared(pathEnv: string = process.env.PATH ?? ''): string | null {
  const candidates = [
    ...pathEnv.split(':').filter(Boolean).map((dir) => join(dir, 'cloudflared')),
    ...KNOWN_LOCATIONS,
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The quick-tunnel address in cloudflared's output, once it has printed one. */
export function quickTunnelUrl(output: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0] ?? null;
}

/** Whether cloudflared reports a live connection to Cloudflare's edge yet. */
export function tunnelRegistered(output: string): boolean {
  return /Registered tunnel connection/i.test(output);
}

/**
 * cloudflared runs under a shell that ends it the moment this process's end of
 * the pipe closes: on close(), on quit, or on a crash, because the operating
 * system closes the pipes of a process that dies.
 */
const WATCHDOG = 'trap \'kill "$CF" 2>/dev/null\' EXIT; '
  + '"$0" tunnel --no-autoupdate --url "$1" 2>&1 & CF=$!; '
  + 'cat >/dev/null; kill "$CF" 2>/dev/null; wait "$CF"';

export async function openQuickTunnel(
  localPort: number,
  options: { cloudflared: string; timeoutMs?: number },
): Promise<QuickTunnel> {
  // A private, empty home: a config of the person's own (for a named tunnel)
  // would otherwise stop cloudflared from opening a quick one.
  const home = await mkdtemp(join(tmpdir(), 'deckwerk-tunnel-'));
  const child = spawn('/bin/sh', ['-c', WATCHDOG, options.cloudflared, `http://127.0.0.1:${localPort}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home },
  });
  let output = '';
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolvePromise) => { resolveExited = resolvePromise; });
  child.on('exit', () => {
    resolveExited();
    void rm(home, { recursive: true, force: true });
  });
  const close = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, 2_000).unref();
  };

  return new Promise<QuickTunnel>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      rejectPromise(new Error(`cloudflared did not open a link in time.\n${output.slice(-600)}`));
    }, options.timeoutMs ?? 30_000);
    // Keep draining cloudflared's log for its whole life, or a full pipe would
    // stall it; only a bounded tail is kept.
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-16_000);
      const url = quickTunnelUrl(output);
      if (!settled && url && tunnelRegistered(output)) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ url, exited, close });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`cloudflared stopped before the link opened.\n${output.slice(-600)}`));
    });
  });
}
