import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { connectScript, remoteDeckFolderName, shellWord } from '../src/server/connectScript.js';
import { findCloudflared, quickTunnelUrl, tunnelRegistered } from '../src/main/remoteTunnel.js';
import { connectAgentBridge, parseSessionUrl, sameMirrorSession } from '../src/cli/agentConnect.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

/**
 * Collaborate → Remote agent. The pasted handshake script is run for real
 * with stand-ins for curl, node and the module system; the bridge is run
 * against a live token-locked session to check it stops when the host does.
 */

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const PARTICIPANT = 'abcdef0123456789';

let work: string;
let fakeBin: string;

function run(script: string, env: Record<string, string> = {}, cwd?: string) {
  return spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, ...env },
  });
}

async function stub(name: string, body: string): Promise<void> {
  const file = join(fakeBin, name);
  await writeFile(file, `#!/bin/bash\n${body}\n`);
  await chmod(file, 0o755);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'remote-agent-'));
  fakeBin = join(work, 'bin');
  await mkdir(fakeBin, { recursive: true });
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('handshake script', () => {
  const script = () => connectScript({
    origin: 'https://brave-otter.trycloudflare.com',
    deckId: 'Fall26',
    participantId: PARTICIPANT,
    token: TOKEN,
  });

  beforeEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
    await mkdir(fakeBin, { recursive: true });
    // curl: "download" a bridge that records how it was started, prints the
    // line the script waits for, and stays up like the real one.
    await stub('curl', [
      'out=""; for ((i=1; i<=$#; i++)); do if [ "${!i}" = "-o" ]; then j=$((i+1)); out="${!j}"; fi; done',
      'printf "%s\\n" "curl $*" >> "$STUB_LOG"',
      'cat > "$out" <<\'JS\'',
      '// stand-in bridge',
      'JS',
    ].join('\n'));
    await stub('node', [
      'if [ "$1" = "-p" ]; then echo "${NODE_MAJOR:-22}"; exit 0; fi',
      'printf "node token=%s" "$DECKWERK_SESSION_TOKEN" >> "$STUB_LOG"',
      'for a in "$@"; do printf " [%s]" "$a" >> "$STUB_LOG"; done; echo >> "$STUB_LOG"',
      'echo "Deck mirrored at somewhere"',
      'sleep 5',
    ].join('\n'));
  });

  it('downloads the bridge, starts it in ./<deck>, and returns the prompt', async () => {
    const home = join(work, 'home-1');
    await mkdir(join(home, 'adajepa', 'slides'), { recursive: true });
    const project = await realpath(join(home, 'adajepa', 'slides'));
    const log = join(work, 'log-1');
    const result = run(script(), { HOME: home, STUB_LOG: log }, project);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`connected. ${project}/Fall26 is live with DeckWerk.`);
    expect(result.stdout).toContain(`cd "${project}/Fall26" && claude`);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines[0]).toContain(`x-deckwerk-token: ${TOKEN}`);
    expect(lines[0]).toContain('https://brave-otter.trycloudflare.com/deckwerk-connect.mjs');
    const argv = [...lines[1].matchAll(/ \[([^\]]*)\]/g)].map((match) => match[1]);
    expect(lines[1].startsWith(`node token=${TOKEN} `)).toBe(true);
    expect(argv[0]).toBe(`${home}/.deckwerk/deckwerk-connect.mjs`);
    expect(argv[1]).toBe(`https://brave-otter.trycloudflare.com/?deck=Fall26&agent=${PARTICIPANT}`);
    expect(argv.slice(2, 4)).toEqual(['--dir', `${project}/Fall26`]);
    expect(argv).toContain('--until-disconnected');
    // The token travels in the environment, never on the command line.
    expect(argv.join(' ')).not.toContain(TOKEN);
  });

  it('takes another folder as its argument, relative or absolute', async () => {
    await mkdir(join(work, 'home-2'), { recursive: true });
    const home = await realpath(join(work, 'home-2'));
    const log = join(work, 'log-2');
    const result = run(`${script()}`.replace('#!/usr/bin/env bash', '#!/usr/bin/env bash\nset -- talks/fall'),
      { HOME: home, STUB_LOG: log }, home);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(`[--dir] [${home}/talks/fall]`);
  });

  it('runs Node 20 with the WebSocket flag, and refuses anything older', async () => {
    const home = join(work, 'home-3');
    await mkdir(home, { recursive: true });
    const log = join(work, 'log-3');
    expect(run(script(), { HOME: home, STUB_LOG: log, NODE_MAJOR: '20' }, home).status).toBe(0);
    expect(await readFile(log, 'utf8')).toContain('[--experimental-websocket]');
    const old = run(script(), { HOME: home, STUB_LOG: log, NODE_MAJOR: '18' }, home);
    expect(old.status).toBe(1);
    expect(old.stdout).toContain('too old');
  });

  it('says what to do when there is no Node at all', async () => {
    await rm(join(fakeBin, 'node'));
    const home = join(work, 'home-4');
    await mkdir(home, { recursive: true });
    const result = run(script(), { HOME: home, STUB_LOG: join(work, 'log-4') }, home);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('module load nodejs');
  });

  it('names the remote folder after the deck, safely', () => {
    expect(remoteDeckFolderName('Weekly Update')).toBe('Weekly-Update');
    expect(remoteDeckFolderName('clients/acme/pitch')).toBe('pitch');
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });
});

describe('quick tunnel', () => {
  it("reads the link and its readiness from cloudflared's log", () => {
    const log = [
      '2026-09-30T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-09-30T12:00:02Z INF +--------------------------------------------------------------------------------------------+',
      '2026-09-30T12:00:02Z INF |  https://brave-otter-sunny-day.trycloudflare.com                                          |',
    ].join('\n');
    expect(quickTunnelUrl(log)).toBe('https://brave-otter-sunny-day.trycloudflare.com');
    expect(tunnelRegistered(log)).toBe(false);
    expect(tunnelRegistered(`${log}\n2026-09-30T12:00:03Z INF Registered tunnel connection connIndex=0`)).toBe(true);
    expect(quickTunnelUrl('nothing yet')).toBeNull();
  });

  it('finds cloudflared on PATH or where Homebrew puts it', async () => {
    const dir = join(work, 'cf-bin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cloudflared'), '');
    expect(findCloudflared(dir)).toBe(join(dir, 'cloudflared'));
  });
});

describe('bridge session URL', () => {
  it('carries the token to the socket', () => {
    const target = parseSessionUrl('http://127.0.0.1:41234/?deck=talk&agent=abcdef0123&token=t0k3n');
    expect(target.token).toBe('t0k3n');
    expect(new URL(target.wsUrl).searchParams.get('token')).toBe('t0k3n');
    expect(parseSessionUrl('http://127.0.0.1:1/?deck=talk&agent=abcdef0123').token).toBeNull();
  });

  it('reuses a mirror when only a loopback port changed', () => {
    const previous = { origin: 'http://127.0.0.1:41234', deckId: 'talk' };
    expect(sameMirrorSession(previous, { origin: 'http://127.0.0.1:52000', deckId: 'talk' })).toBe(true);
    expect(sameMirrorSession(previous, { origin: 'http://127.0.0.1:52000', deckId: 'other' })).toBe(false);
    expect(sameMirrorSession({ origin: 'http://lab:5800', deckId: 'talk' },
      { origin: 'http://other:5800', deckId: 'talk' })).toBe(false);
  });
});

describe('remote-agent session', () => {
  let root: string;
  let server: RunningCollabServer;
  let registry: LocalAgentRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'remote-session-'));
    await mkdir(join(root, 'talk'), { recursive: true });
    await saveDeck(join(root, 'talk'), parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 's1' }] }));
    await writeFile(join(root, 'talk', 'theme.css'), '/* theme */\n');
    registry = new LocalAgentRegistry();
    server = await startCollabServer({
      rootDir: root, port: 0, host: '127.0.0.1', hostedDeckId: 'talk', sessionToken: TOKEN,
      agentMode: true, localAgents: registry,
    });
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    registry.close();
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

  it('serves the handshake script for the link it was reached through', async () => {
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: `/connect.sh?token=${TOKEN}&agent=${PARTICIPANT}`,
        headers: { 'x-forwarded-proto': 'https', host: 'brave-otter.trycloudflare.com' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(text).toContain("ORIGIN='https://brave-otter.trycloudflare.com'");
    expect(text).toContain(`agent=${PARTICIPANT}`);
    expect((await fetch(`http://127.0.0.1:${server.port}/connect.sh?agent=${PARTICIPANT}`)).status).toBe(403);
  });

  const quietIo = (cwd: string) => ({ out: () => {}, err: () => {}, cwd });

  it('stops the bridge when the host ends the session', async () => {
    const dir = join(root, 'mirror-1');
    const bridge = connectAgentBridge({
      url: `http://127.0.0.1:${server.port}/?deck=talk&agent=${PARTICIPANT}&token=${TOKEN}`,
      dir, io: quietIo(root), giveUpAfterMs: 20_000,
    });
    await bridge.ready;
    server.notifyEnded();
    await expect(Promise.race([
      bridge.closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000)),
    ])).resolves.toBe('closed');
  });

  it('gives up once the session has been unreachable long enough', async () => {
    const dir = join(root, 'mirror-2');
    const bridge = connectAgentBridge({
      url: `http://127.0.0.1:${server.port}/?deck=talk&agent=${PARTICIPANT}&token=${TOKEN}`,
      dir, io: quietIo(root), giveUpAfterMs: 1_200,
    });
    await bridge.ready;
    // The link disappears without a goodbye, as when the host's app dies.
    await server.close();
    await expect(Promise.race([
      bridge.closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 8_000)),
    ])).resolves.toBe('closed');
  }, 15_000);
});
