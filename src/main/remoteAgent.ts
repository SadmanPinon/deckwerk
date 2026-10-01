/**
 * Remote-agent sessions: Claude Code (or any terminal agent) on another
 * machine, typically a lab server or cluster reached over SSH, editing the open
 * presentation live while the desktop editor watches.
 *
 * That machine cannot open a connection back to this one, so it starts here:
 * a single `ssh -R` forwards the hosted session's port onto the remote
 * loopback and runs a bootstrap there. The bootstrap fetches the session's own
 * bridge through the tunnel (`deckwerk-connect.mjs`, the same file the browser
 * Agent panel hands out), which mirrors the deck into a folder, keeps it in
 * sync both ways, and optionally starts the agent in it. The remote side needs
 * an SSH login and Node 22; nothing is installed there.
 *
 * A forwarded port is loopback on a machine other people may share, so the
 * session requires a token (`sessionToken` in collabServer.ts). The bootstrap
 * hands it to the bridge through the environment, which keeps it out of the
 * process list once the bridge is running.
 */

import type { RemoteAgentSetup } from '@shared/ipc.js';

export interface RemoteAgentCommandInput extends RemoteAgentSetup {
  /** Where this machine's hosted session listens. */
  localPort: number;
  /** The loopback port the tunnel opens on the remote machine. */
  remotePort: number;
  deckId: string;
  participantId: string;
  token: string;
  /** How the agent appears in presence and History. */
  name: string;
}

/** Plain ssh destinations only: never an option, never shell syntax. */
export function isSshDestination(host: string): boolean {
  return /^[A-Za-z0-9_.@%+:[\]-]{1,255}$/.test(host) && !host.startsWith('-');
}

/** One POSIX shell word holding `value` exactly. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A remote path as shell words: a leading `~` becomes "$HOME", the rest stays literal. */
export function remotePathWords(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/** Where a deck lands remotely unless the person picks a folder. */
export function defaultRemoteFolder(deckName: string): string {
  const safe = deckName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return `~/deckwerk/${safe || 'deck'}`;
}

/**
 * A high port for the remote end of the tunnel. Random rather than fixed:
 * login nodes are shared, and a fixed port is the one somebody else already
 * forwarded.
 */
export function pickRemotePort(random: () => number = Math.random): number {
  return 20_000 + Math.floor(random() * 40_000);
}

/**
 * The bash the remote machine runs, on one line: the login shell that receives
 * it may be csh, which rejects newlines inside quotes. It also avoids `!`,
 * which csh expands even inside single quotes.
 */
export function remoteBootstrap(input: RemoteAgentCommandInput): string {
  const origin = `http://127.0.0.1:${input.remotePort}`;
  const session = `${origin}/?deck=${encodeURIComponent(input.deckId)}`
    + `&agent=${encodeURIComponent(input.participantId)}`;
  const folder = input.folder?.trim() || defaultRemoteFolder(input.deckId);
  const agent = input.agent?.trim() ?? '';
  const setup = input.setup?.trim() ?? '';
  // On failure, stay in a login shell: the message stays readable and the
  // tunnel stays up while the person fixes whatever was missing.
  const stay = 'exec "${SHELL:-bash}" -l';
  const download = 'fetch(process.env.DECKWERK_BRIDGE_URL,'
    + ' { headers: { "x-deckwerk-token": process.env.DECKWERK_SESSION_TOKEN } })'
    + '.then((r) => { if (r.status >= 400) throw new Error("HTTP " + r.status); return r.text(); })'
    + '.then((t) => require("fs").writeFileSync(require("os").homedir() + "/.deckwerk/deckwerk-connect.mjs", t))'
    + '.catch((e) => { console.error(e.message); process.exit(1); })';
  const steps = [
    `export DECKWERK_SESSION_TOKEN=${shellQuote(input.token)}`,
    setup ? `{ ${setup} ; }` : null,
    'command -v node >/dev/null 2>&1 || { echo "DeckWerk: node is not on PATH on $(hostname).'
      + ' Install Node 22 or newer (nvm works without root), or add a setup command such as: module load nodejs";'
      + ` ${stay}; }`,
    `node -e ${shellQuote('process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)')}`
      + ` || { echo "DeckWerk: Node 22 or newer is needed; $(hostname) has $(node -v)."; ${stay}; }`,
    'mkdir -p "$HOME/.deckwerk"',
    `DECKWERK_BRIDGE_URL=${shellQuote(`${origin}/deckwerk-connect.mjs`)} node -e ${shellQuote(download)}`
      + ` || { echo "DeckWerk: could not fetch the bridge through the tunnel. Is DeckWerk still sharing this deck?"; ${stay}; }`,
    `exec node "$HOME/.deckwerk/deckwerk-connect.mjs" ${shellQuote(session)}`
      + ` --dir ${remotePathWords(folder)} --name ${shellQuote(input.name)}`
      + (agent ? ` --agent ${shellQuote(agent)}` : ''),
  ];
  return steps.filter((step): step is string => step !== null).join('; ');
}

/** The one command, run on this machine, that connects the remote agent. */
export function remoteAgentCommand(input: RemoteAgentCommandInput): string {
  if (!isSshDestination(input.host)) throw new Error(`Not an SSH host: ${input.host}`);
  return [
    'ssh',
    '-t',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-R', `${input.remotePort}:127.0.0.1:${input.localPort}`,
    shellQuote(input.host),
    shellQuote(`bash -lc ${shellQuote(remoteBootstrap(input))}`),
  ].join(' ');
}

/** Concrete host aliases from an ssh config, for suggestions; patterns are skipped. */
export function sshConfigHosts(config: string): string[] {
  const hosts = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    for (const name of match[1].split(/\s+/)) {
      if (name && !/[*?!]/.test(name)) hosts.add(name);
    }
  }
  return [...hosts];
}
