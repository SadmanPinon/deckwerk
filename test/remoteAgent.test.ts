import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import {
  defaultRemoteFolder,
  isSshDestination,
  pickRemotePort,
  remoteAgentCommand,
  remotePathWords,
  shellQuote,
  sshConfigHosts,
  type RemoteAgentCommandInput,
} from '../src/main/remoteAgent.js';
import { parseSessionUrl, sameMirrorSession } from '../src/cli/agentConnect.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

/**
 * Collaborate → Remote agent. The command is checked by running it through
 * real shells with stand-ins for ssh and node: what ssh receives, what the
 * remote login shell (bash or csh) hands to bash, and what the bootstrap then
 * does, token and paths included. The token gate is checked on a live server.
 */

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

const input = (over: Partial<RemoteAgentCommandInput> = {}): RemoteAgentCommandInput => ({
  host: 'cluster',
  folder: '~/project A/slides',
  agent: "claude --add-dir ~/runs --append-system-prompt 'it''s fine'",
  setup: 'module load nodejs/22',
  localPort: 5800,
  remotePort: 41234,
  deckId: 'Weekly Update',
  participantId: 'abcdef0123456789',
  token: TOKEN,
  name: 'Agent on cluster',
  ...over,
});

let work: string;
let fakeBin: string;

/** Run `script` with `shell -c`, stand-ins first on PATH; returns stdout and the logs. */
function run(shell: string, script: string, env: Record<string, string> = {}) {
  return spawnSync(shell, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, ...env },
  });
}

async function readArgs(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\0').slice(0, -1);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'remote-agent-'));
  fakeBin = join(work, 'bin');
  await mkdir(fakeBin, { recursive: true });
  // ssh and bash stand-ins record their argv, NUL-separated, so word
  // boundaries survive.
  for (const name of ['ssh', 'bash']) {
    const file = join(fakeBin, name);
    await writeFile(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "$ARGS_OUT"\n`);
    await chmod(file, 0o755);
  }
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('remote agent command', () => {
  it('quotes any string into exactly one shell word', () => {
    for (const value of ["it's", 'a b', '$HOME `x` "q"', "'", '', 'semi;colon & | <>']) {
      const out = run('/bin/sh', `printf '%s' ${shellQuote(value)}`);
      expect(out.stdout).toBe(value);
    }
  });

  it('hands ssh a reverse tunnel, the host, and one remote command', async () => {
    const argsOut = join(work, 'ssh-args');
    const result = run('/bin/bash', remoteAgentCommand(input()), { ARGS_OUT: argsOut });
    expect(result.status).toBe(0);
    const args = await readArgs(argsOut);
    expect(args.slice(0, -1)).toEqual([
      '-t',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-R', '41234:127.0.0.1:5800',
      'cluster',
    ]);
    expect(args.at(-1)!.startsWith('bash -lc ')).toBe(true);
  });

  for (const loginShell of ['/bin/sh', '/bin/csh']) {
    it(`reaches bash intact through a ${loginShell.split('/').pop()} login shell`, async () => {
      const sshArgs = join(work, 'ssh-args-2');
      run('/bin/bash', remoteAgentCommand(input()), { ARGS_OUT: sshArgs });
      const remote = (await readArgs(sshArgs)).at(-1)!;
      const bashArgs = join(work, `bash-args-${loginShell.split('/').pop()}`);
      const result = run(loginShell, remote, { ARGS_OUT: bashArgs });
      expect(result.status, result.stderr).toBe(0);
      const [flag, script] = await readArgs(bashArgs);
      expect(flag).toBe('-lc');
      // One line: csh refuses newlines inside quotes.
      expect(script).not.toContain('\n');
      const syntax = spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' });
      expect(syntax.status, syntax.stderr).toBe(0);
    });
  }

  it('fetches the bridge through the tunnel and starts it in the folder, token kept out of argv', async () => {
    const home = join(work, 'home');
    await mkdir(home, { recursive: true });
    const log = join(work, 'node-log');
    const node = join(fakeBin, 'node');
    await writeFile(node, [
      '#!/bin/sh',
      'if [ "$1" = "-e" ]; then',
      '  case "$2" in',
      '    *versions.node*) exit 0 ;;',
      '    *fetch*) printf "fetch %s token=%s\\n" "$DECKWERK_BRIDGE_URL" "$DECKWERK_SESSION_TOKEN" >> "$NODE_LOG"; exit 0 ;;',
      '  esac',
      'fi',
      'printf "exec token=%s" "$DECKWERK_SESSION_TOKEN" >> "$NODE_LOG"',
      'for a in "$@"; do printf " [%s]" "$a" >> "$NODE_LOG"; done',
      'echo >> "$NODE_LOG"',
    ].join('\n'));
    await chmod(node, 0o755);
    const module = join(fakeBin, 'module');
    await writeFile(module, '#!/bin/sh\necho "module $*" >> "$NODE_LOG"\n');
    await chmod(module, 0o755);

    const sshArgs = join(work, 'ssh-args-3');
    run('/bin/bash', remoteAgentCommand(input()), { ARGS_OUT: sshArgs });
    const bashArgs = join(work, 'bash-args-3');
    run('/bin/sh', (await readArgs(sshArgs)).at(-1)!, { ARGS_OUT: bashArgs });
    const [, script] = await readArgs(bashArgs);

    const result = run('/bin/bash', script, { HOME: home, NODE_LOG: log });
    await rm(node);
    await rm(module);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('module load nodejs/22');
    expect(lines[1]).toBe(`fetch http://127.0.0.1:41234/deckwerk-connect.mjs token=${TOKEN}`);
    const exec = lines[2];
    expect(exec.startsWith(`exec token=${TOKEN} `)).toBe(true);
    const argv = [...exec.matchAll(/ \[([^\]]*)\]/g)].map((match) => match[1]);
    expect(argv).toEqual([
      `${home}/.deckwerk/deckwerk-connect.mjs`,
      'http://127.0.0.1:41234/?deck=Weekly%20Update&agent=abcdef0123456789',
      '--dir', `${home}/project A/slides`,
      '--name', 'Agent on cluster',
      '--agent', "claude --add-dir ~/runs --append-system-prompt 'it''s fine'",
    ]);
    expect(argv.join(' ')).not.toContain(TOKEN);
  });

  it('says what is missing when the remote machine has no node, and keeps the shell', async () => {
    const sshArgs = join(work, 'ssh-args-4');
    run('/bin/bash', remoteAgentCommand(input({ setup: '' })), { ARGS_OUT: sshArgs });
    const bashArgs = join(work, 'bash-args-4');
    run('/bin/sh', (await readArgs(sshArgs)).at(-1)!, { ARGS_OUT: bashArgs });
    const [, script] = await readArgs(bashArgs);
    const result = run('/bin/bash', script, { HOME: work, SHELL: '/usr/bin/true' });
    expect(result.stdout).toContain('node is not on PATH');
    expect(result.status).toBe(0);
  });

  it('syncs without starting an agent when none is named', async () => {
    const sshArgs = join(work, 'ssh-args-5');
    run('/bin/bash', remoteAgentCommand(input({ agent: '' })), { ARGS_OUT: sshArgs });
    const bashArgs = join(work, 'bash-args-5');
    run('/bin/sh', (await readArgs(sshArgs)).at(-1)!, { ARGS_OUT: bashArgs });
    const [, script] = await readArgs(bashArgs);
    expect(script).not.toContain('--agent');
  });

  it('refuses anything but a plain ssh destination', () => {
    for (const ok of ['cluster', 'me@login.example.edu', 'node-12.cluster', 'me@[::1]']) {
      expect(isSshDestination(ok)).toBe(true);
    }
    for (const bad of ['-oProxyCommand=evil', 'a b', 'host;rm -rf ~', "x'y", '', '$(id)']) {
      expect(isSshDestination(bad)).toBe(false);
    }
    expect(() => remoteAgentCommand(input({ host: '-oProxyCommand=evil' }))).toThrow();
  });

  it('defaults the folder per deck and expands ~ on the remote side', () => {
    expect(defaultRemoteFolder('Weekly Update')).toBe('~/deckwerk/Weekly-Update');
    expect(remotePathWords('~/a b')).toBe(`"$HOME"/'a b'`);
    expect(remotePathWords('/scratch/me')).toBe(`'/scratch/me'`);
    expect(remotePathWords('~')).toBe('"$HOME"');
  });

  it('picks a high remote port and reads concrete hosts from an ssh config', () => {
    expect(pickRemotePort(() => 0)).toBe(20_000);
    expect(pickRemotePort(() => 0.999999)).toBeLessThan(60_000);
    expect(sshConfigHosts([
      'Host cluster narval',
      '  HostName narval.alliancecan.ca',
      'Host *.internal',
      'host lab-gpu',
      'Host !bad ?x',
    ].join('\n'))).toEqual(['cluster', 'narval', 'lab-gpu']);
  });
});

describe('bridge session URL', () => {
  it('carries the token to the socket and back out', () => {
    const target = parseSessionUrl('http://127.0.0.1:41234/?deck=talk&agent=abcdef0123&token=t0k3n');
    expect(target.token).toBe('t0k3n');
    expect(new URL(target.wsUrl).searchParams.get('token')).toBe('t0k3n');
    expect(parseSessionUrl('http://127.0.0.1:1/?deck=talk&agent=abcdef0123').token).toBeNull();
  });

  it('reuses a mirror when only the tunnel port changed', () => {
    const previous = { origin: 'http://127.0.0.1:41234', deckId: 'talk' };
    expect(sameMirrorSession(previous, { origin: 'http://127.0.0.1:52000', deckId: 'talk' })).toBe(true);
    expect(sameMirrorSession(previous, { origin: 'http://127.0.0.1:52000', deckId: 'other' })).toBe(false);
    expect(sameMirrorSession({ origin: 'http://lab:5800', deckId: 'talk' },
      { origin: 'http://other:5800', deckId: 'talk' })).toBe(false);
  });
});

describe('session token gate', () => {
  let root: string;
  let server: RunningCollabServer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'token-gate-'));
    await mkdir(join(root, 'talk'), { recursive: true });
    await saveDeck(join(root, 'talk'), parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 's1' }] }));
    server = await startCollabServer({
      rootDir: root, port: 0, host: '127.0.0.1', hostedDeckId: 'talk', sessionToken: TOKEN,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('answers only requests that carry the token', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/deck?deck=talk`)).status).toBe(403);
    expect((await fetch(`${base}/api/deck?deck=talk&token=wrong`)).status).toBe(403);
    expect((await fetch(`${base}/api/deck?deck=talk&token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${base}/api/deck?deck=talk`, { headers: { 'x-deckwerk-token': TOKEN } })).status)
      .toBe(200);
  });

  it('refuses a socket without the token and admits one with it', async () => {
    const outcome = (url: string) => new Promise<string>((resolve) => {
      const socket = new WebSocket(url);
      socket.once('open', () => { socket.close(); resolve('open'); });
      socket.once('error', () => resolve('refused'));
    });
    const base = `ws://127.0.0.1:${server.port}/ws?deck=talk`;
    expect(await outcome(base)).toBe('refused');
    expect(await outcome(`${base}&token=${TOKEN}`)).toBe('open');
  });
});
