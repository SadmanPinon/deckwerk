import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let peerBrowser: RunningBrowser | null = null;
let peer: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  peer?.close();
  editor = null;
  peer = null;
  await stopBrowser(peerBrowser?.process ?? null);
  peerBrowser = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  workDir = '';
}, 30_000);

interface PaintedCursor {
  name: string | null;
  color: string | null;
  background: string;
  opacity: number;
  glyph: { x: number; y: number; width: number; height: number };
  label: { x: number; y: number; width: number; height: number } | null;
}

async function paintedCursor(viewer: Cdp, name: string): Promise<PaintedCursor | null> {
  return viewer.evaluate<PaintedCursor | null>(`(() => {
    const cursor = [...document.querySelectorAll('.presence-cursor')]
      .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(name)});
    if (!cursor) return null;
    const label = cursor.querySelector('span');
    const glyphRect = cursor.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    const labelStyle = label ? getComputedStyle(label) : null;
    return {
      name: label?.textContent ?? null,
      color: cursor.querySelector('path')?.getAttribute('fill') ?? null,
      background: labelStyle?.backgroundColor ?? '',
      opacity: Number.parseFloat(getComputedStyle(cursor).opacity),
      glyph: { x: glyphRect.x, y: glyphRect.y, width: glyphRect.width, height: glyphRect.height },
      label: labelRect
        ? { x: labelRect.x, y: labelRect.y, width: labelRect.width, height: labelRect.height }
        : null,
    };
  })()`);
}

async function paintedPixel(viewer: Cdp, x: number, y: number): Promise<[number, number, number, number]> {
  const shot = await viewer.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: x - 1, y: y - 1, width: 3, height: 3, scale: 1 },
    captureBeyondViewport: false,
  });
  return viewer.evaluate<[number, number, number, number]>(`(async () => {
    const image = new Image();
    image.src = 'data:image/png;base64,${shot.data}';
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.width;
    surface.height = image.height;
    const context = surface.getContext('2d');
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(1, 1, 1, 1).data);
  })()`);
}

function cssRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
}

async function observeCursorMotion(
  mover: Cdp,
  viewer: Cdp,
  name: string,
  points: Array<{ x: number; y: number }>,
  intervalMs: number,
  label: string,
): Promise<PaintedCursor[]> {
  let finished = false;
  const movement = mover.hoverPathWithin(
    '#canvas .stage',
    points,
    intervalMs,
    label,
  ).finally(() => { finished = true; });
  const samples: PaintedCursor[] = [];
  do {
    const sample = await paintedCursor(viewer, name);
    if (sample) samples.push(sample);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (!finished);
  await movement;

  expect(samples.length, `${label}: too few observable frames`).toBeGreaterThan(2);
  expect(samples.every((sample) => (
    sample.name === name
    && sample.opacity === 1
    && Boolean(sample.label)
    && sample.background === cssRgb(sample.color!)
  )), `${label}: cursor or colored name tag vanished`).toBe(true);
  const positions = new Set(samples.map((sample) => (
    `${Math.round(sample.glyph.x)},${Math.round(sample.glyph.y)}`
  )));
  expect(positions.size, `${label}: cursor did not visibly move`).toBeGreaterThan(1);
  return samples;
}

/**
 * Capability gate: `paintedPixel` reads real pixels via CDP
 * `Page.captureScreenshot` against windows that are never shown on screen.
 * That needs an OS compositor that still produces frames for hidden windows
 * (macOS does). Under CI's bare Xvfb there is no window manager or compositor,
 * Chromium never emits a frame, and the CDP call blocks forever — on CI this
 * suite burned its entire 180s timeout without a single `eventually`
 * diagnostic while every non-screenshot browser suite passed. The workflow
 * sets CI_NO_WINDOW_MANAGER=1 (see .github/workflows/ci.yml) to declare that
 * environment explicitly; the suite then shows up as skipped, with the green
 * placeholder below recording why — never as silently green.
 */
const noWindowManager = process.env.CI_NO_WINDOW_MANAGER === '1';

describe.skipIf(!electronBinary || noWindowManager)('desktop collaboration handoff', () => {
  // Two native Electron windows plus a collab server: comfortably inside the
  // default 60s on a workstation, but not on a 2-core CI runner under load.
  it('keeps the native editor and paints live tagged cursors in both directions', {
    timeout: 180_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-collaboration-handoff-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'handoff-deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await materializeDesktopApp(appDir, 'deckwerk-collaboration-handoff-test');

    const deck = emptyDeck('Collaboration handoff');
    deck.slides[0]!.elements.push({
      id: 'handoff-title', type: 'text', x: 160, y: 120, w: 1200, h: 180,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
      html: 'The authoritative collaborative deck', align: 'left', valign: 'middle',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, env: { DECKWERK_HEADLESS_TEST: '1' } });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;
    const editorTarget = await findTarget(
      debugPort,
      (candidate) => candidate.url.includes('/editor/index.html'),
      appLog,
      20_000,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(
      async () => editor!.evaluate<boolean>(`window.api.getDeck().then((session) => {
        const trigger = document.querySelector('#collaborate-trigger');
        const rect = trigger?.getBoundingClientRect();
        return session?.dir === ${JSON.stringify(deckDir)}
          && Boolean(rect && rect.width > 0 && rect.height > 0);
      })`),
      'desktop editor did not expose the Collaborate control',
    );

    // Reproduce the broken state without requiring a signed-in Codex account:
    // the IPC call establishes the same hidden authoritative server used by
    // the Agent panel.
    await editor.evaluate(`window.api.startAgentSession({
      agent: true,
      activeSlideId: ${JSON.stringify(deck.slides[0]!.id)},
      selectedSlideIds: [],
      selectedElementIds: []
    }).then((session) => session.active)`);
    const collaborationStartedAt = Date.now();
    await editor.click('#collaborate-trigger', 'Collaborate');
    // Collaborate offers people or a remote agent; this is the people one.
    await editor.click('#collaborate-chooser .collaborate-choice-invite', 'Invite people');

    // Collaborate must not navigate, close, or replace the native editor.
    // Waiting on its changed toolbar state also measures application-level
    // readiness rather than merely observing that an HTTP listener exists.
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(
      location.pathname.includes('/editor/index.html')
      && document.querySelector('#collaborate-trigger')?.textContent === 'End collaboration'
      && document.querySelector('#canvas [data-element-id="handoff-title"]')
    )`), 'native desktop editor did not join collaboration in place');
    expect(Date.now() - collaborationStartedAt).toBeLessThan(3_000);

    const wsUrl = await editor.evaluate<string>(`window.api.startCollab({
      agent: false,
      activeSlideId: ${JSON.stringify(deck.slides[0]!.id)},
      selectedSlideIds: [],
      selectedElementIds: []
    }).then((connection) => connection.wsUrl)`);

    // Join through a completely separate browser process. This is the Web UI
    // half of the test; `editor` remains the native Electron renderer.
    const peerProfileDir = join(workDir, 'peer-profile');
    await mkdir(peerProfileDir, { recursive: true });
    const peerUrl = new URL(wsUrl);
    peerUrl.protocol = 'http:';
    peerUrl.pathname = '/';
    peerUrl.searchParams.set('name', 'Peer Browser');
    peerBrowser = await launchBrowser(peerUrl.toString(), peerProfileDir);
    const peerTarget = await findTarget(
      peerBrowser.debugPort,
      (candidate) => candidate.url.includes('deck=handoff-deck'),
      peerBrowser.log,
      20_000,
    );
    peer = await Cdp.connect(peerTarget.webSocketDebuggerUrl!);
    await eventually(async () => peer!.evaluate<boolean>(
      `document.documentElement?.dataset.collabReady === 'true'
        && window.store?.get?.().deck.title === 'Collaboration handoff'`,
    // The peer's page is served by the desktop app's own process, which is
    // also laying out its editor; give a loaded machine time to answer.
    ), 'external collaboration peer did not receive the desktop deck', Boolean, 30_000);

    await editor.hoverWithin('#canvas .stage', 0.7, 0.65, 'native desktop canvas');
    await editor.click('#canvas [data-element-id="handoff-title"]', 'desktop title');
    const desktopPresence = await eventually(async () => peer!.evaluate<{
      cursorName: string | null;
      cursorX: number | null;
      cursorY: number | null;
      selectionName: string | null;
      railName: string | null;
    }>(`(() => {
      const cursor = document.querySelector('.presence-cursor');
      return {
        cursorName: cursor?.querySelector('span')?.textContent ?? null,
        cursorX: cursor ? Number.parseFloat(cursor.style.left) : null,
        cursorY: cursor ? Number.parseFloat(cursor.style.top) : null,
        selectionName: document.querySelector('.presence-selection .presence-tag')?.textContent ?? null,
        railName: document.querySelector('.rail-presence-dot')?.getAttribute('title') ?? null
      };
    })()`), 'external peer did not render desktop presence', (value) => (
      Boolean(value.cursorName)
      && value.selectionName === value.cursorName
      && value.railName === value.cursorName
      && value.cursorX !== null && Number.isFinite(value.cursorX)
      && value.cursorY !== null && Number.isFinite(value.cursorY)
    ));
    expect(desktopPresence.cursorX).toBeGreaterThan(0);
    expect(desktopPresence.cursorX).toBeLessThan(deck.canvas.w);
    expect(desktopPresence.cursorY).toBeGreaterThan(0);
    expect(desktopPresence.cursorY).toBeLessThan(deck.canvas.h);

    const webPaint = await eventually(
      () => paintedCursor(peer!, desktopPresence.cursorName!),
      'Web UI did not visibly paint the native desktop mouse cursor and name tag',
      (value) => Boolean(value?.label && value.opacity === 1),
    );
    if (!webPaint) throw new Error('Web UI cursor disappeared before visual assertions');
    expect(webPaint.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(webPaint.background).toBe(cssRgb(webPaint.color!));
    const webTagPixel = await paintedPixel(
      peer,
      webPaint.label!.x + webPaint.label!.width / 2,
      webPaint.label!.y + webPaint.label!.height / 2,
    );
    expect(webTagPixel[3]).toBe(255);
    expect(Math.max(...webTagPixel.slice(0, 3))).toBeGreaterThan(40);

    const nativeTrace: Array<{ x: number; y: number }> = [];
    for (const [x, y] of [[0.2, 0.25], [0.5, 0.48], [0.8, 0.72]]) {
      await editor.hoverWithin('#canvas .stage', x, y, 'native desktop cursor trace');
      const previous = nativeTrace.at(-1);
      nativeTrace.push(await eventually(async () => peer!.evaluate<{ x: number; y: number }>(`(() => {
        const cursor = [...document.querySelectorAll('.presence-cursor')]
          .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(desktopPresence.cursorName)});
        return { x: Number.parseFloat(cursor?.style.left ?? 'NaN'),
          y: Number.parseFloat(cursor?.style.top ?? 'NaN') };
      })()`), 'Web UI cursor did not follow native mouse movement', (value) => (
        Number.isFinite(value.x) && Number.isFinite(value.y)
        && (!previous || (value.x > previous.x + 100 && value.y > previous.y + 80))
      )));
    }

    await peer.hoverWithin('#canvas .stage', 0.35, 0.4, 'peer collaboration canvas');
    await peer.click('#canvas [data-element-id="handoff-title"]', 'peer title');
    const desktopPaint = await eventually(
      () => paintedCursor(editor!, 'Peer Browser'),
      'native desktop UI did not visibly paint the Web UI mouse cursor and name tag',
      (value) => Boolean(value?.label && value.opacity === 1),
    );
    if (!desktopPaint) throw new Error('desktop cursor disappeared before visual assertions');
    expect(desktopPaint.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(desktopPaint.background).toBe(cssRgb(desktopPaint.color!));
    const desktopTagPixel = await paintedPixel(
      editor,
      desktopPaint.label!.x + desktopPaint.label!.width / 2,
      desktopPaint.label!.y + desktopPaint.label!.height / 2,
    );
    expect(desktopTagPixel[3]).toBe(255);
    expect(Math.max(...desktopTagPixel.slice(0, 3))).toBeGreaterThan(40);
    expect(await editor.evaluate<boolean>(`
      [...document.querySelectorAll('.presence-selection .presence-tag')]
        .some((node) => node.textContent === 'Peer Browser')
    `)).toBe(true);

    const firstWebPoint = await editor.evaluate<{ x: number; y: number }>(`(() => {
      const cursor = [...document.querySelectorAll('.presence-cursor')]
        .find((node) => node.querySelector('span')?.textContent === 'Peer Browser');
      return { x: Number.parseFloat(cursor.style.left), y: Number.parseFloat(cursor.style.top) };
    })()`);
    await peer.hoverWithin('#canvas .stage', 0.68, 0.7, 'Web UI cursor trace');
    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const cursor = [...document.querySelectorAll('.presence-cursor')]
        .find((node) => node.querySelector('span')?.textContent === 'Peer Browser');
      return Number.parseFloat(cursor?.style.left ?? 'NaN') > ${firstWebPoint.x + 100}
        && Number.parseFloat(cursor?.style.top ?? 'NaN') > ${firstWebPoint.y + 80};
    })()`), 'native desktop cursor did not follow Web UI mouse movement');

    const slowPath = Array.from({ length: 12 }, (_, index) => ({
      x: 0.16 + index * 0.055,
      y: index % 2 === 0 ? 0.28 : 0.62,
    }));
    const quickPath = Array.from({ length: 80 }, (_, index) => ({
      x: 0.12 + (index / 79) * 0.76,
      y: 0.5 + Math.sin(index / 3) * 0.25,
    }));

    await observeCursorMotion(
      editor,
      peer,
      desktopPresence.cursorName!,
      slowPath,
      90,
      'slow native-to-Web cursor motion',
    );
    await observeCursorMotion(
      peer,
      editor,
      'Peer Browser',
      slowPath.slice().reverse(),
      90,
      'slow Web-to-native cursor motion',
    );
    await observeCursorMotion(
      editor,
      peer,
      desktopPresence.cursorName!,
      quickPath,
      2,
      'rapid native-to-Web cursor motion',
    );
    await observeCursorMotion(
      peer,
      editor,
      'Peer Browser',
      quickPath.slice().reverse(),
      2,
      'rapid Web-to-native cursor motion',
    );

    // A stationary pointer is still present. It must not fade into practical
    // invisibility after the old five-second inactivity timeout.
    await new Promise<void>((resolve) => setTimeout(resolve, 5_500));
    const idleWebCursor = await paintedCursor(peer, desktopPresence.cursorName!);
    const idleDesktopCursor = await paintedCursor(editor, 'Peer Browser');
    expect(idleWebCursor?.opacity).toBe(1);
    expect(idleWebCursor?.label).not.toBeNull();
    expect(idleDesktopCursor?.opacity).toBe(1);
    expect(idleDesktopCursor?.label).not.toBeNull();

    // Leaving the slide is the one deliberate disappearance; re-entry must
    // immediately recreate the arrow and colored name tag on both surfaces.
    await editor.hoverWithin('#toolbar', 0.5, 0.5, 'native outside canvas');
    await eventually(
      () => paintedCursor(peer!, desktopPresence.cursorName!),
      'Web UI retained desktop cursor after it left the slide',
      (value) => value === null,
    );
    await editor.hoverWithin('#canvas .stage', 0.4, 0.4, 'native canvas re-entry');
    await eventually(
      () => paintedCursor(peer!, desktopPresence.cursorName!),
      'Web UI did not restore desktop cursor after re-entry',
      (value) => Boolean(value?.label && value.opacity === 1),
    );
    await peer.hoverWithin('#toolbar', 0.5, 0.5, 'Web UI outside canvas');
    await eventually(
      () => paintedCursor(editor!, 'Peer Browser'),
      'native UI retained Web cursor after it left the slide',
      (value) => value === null,
    );
    await peer.hoverWithin('#canvas .stage', 0.45, 0.45, 'Web UI canvas re-entry');
    await eventually(
      () => paintedCursor(editor!, 'Peer Browser'),
      'native UI did not restore Web cursor after re-entry',
      (value) => Boolean(value?.label && value.opacity === 1),
    );

    // Safari sometimes supplies only the compatibility mouse stream while
    // hovering. Exercise that path across the real socket and assert the
    // resulting canvas coordinates, not merely that a cursor node exists.
    await peer.evaluate(`(() => {
      const host = document.querySelector('#canvas');
      const stage = document.querySelector('#canvas .stage');
      const rect = stage.getBoundingClientRect();
      host.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + rect.width * 0.82,
        clientY: rect.top + rect.height * 0.72,
        bubbles: true
      }));
    })()`);
    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const cursor = [...document.querySelectorAll('.presence-cursor')]
        .find((node) => node.querySelector('span')?.textContent === 'Peer Browser');
      return Boolean(cursor
        && Number.parseFloat(cursor.style.left) > 1500
        && Number.parseFloat(cursor.style.top) > 700);
    })()`), 'desktop did not receive Safari-compatible mouse cursor coordinates');

    // A browser reload creates a new WebSocket/client id. The host must discard
    // the old peer, accept the replacement, and render its new presence rather
    // than retaining a ghost or requiring its own reload.
    await peer.call('Page.reload', { ignoreCache: true });
    await eventually(async () => peer!.evaluate<boolean>(
      `document.documentElement?.dataset.collabReady === 'true'
        && window.store?.get?.().deck.title === 'Collaboration handoff'`,
    ), 'reloaded peer did not reconnect to the collaboration');
    await peer.click('#canvas [data-element-id="handoff-title"]', 'reconnected peer title');
    await eventually(async () => editor!.evaluate<boolean>(
      `[...document.querySelectorAll('.presence-selection .presence-tag')]
        .some((node) => node.textContent === 'Peer Browser')`,
    ), 'desktop did not recover peer presence after reconnect');

    // End from the native toolbar; the same window and selected element stay.
    await editor.click('#collaborate-trigger', 'End collaboration');
    expect(await editor.evaluate<boolean>(
      `document.querySelector('#end-collaboration-popover')?.getAttribute('role') === 'alertdialog'`,
    )).toBe(true);
    await editor.click('.end-collaboration-confirm', 'confirm End collaboration');
    await eventually(async () => peer!.evaluate<boolean>(
      `document.querySelector('#connection-notice')?.dataset.state === 'ended'`,
    ), 'remote peer was not told that collaboration ended');
    await eventually(async () => editor!.evaluate<boolean>(`
      window.api.getDeck().then((session) => Boolean(
        location.pathname.includes('/editor/index.html')
        && document.querySelector('#collaborate-trigger')?.textContent === 'Collaborate'
        && session?.deck.title === 'Collaboration handoff'
        && document.querySelector('#canvas [data-element-id="handoff-title"]')
        && document.querySelectorAll('#canvas .sel-box').length === 1
      ))
    `), 'native desktop editor did not remain intact after ending collaboration');
  });
});

describe.skipIf(Boolean(electronBinary) && !noWindowManager)('desktop collaboration handoff (skipped)', () => {
  it('needs Electron and compositor frames for Page.captureScreenshot (absent under bare Xvfb)', () => {
    expect(!electronBinary || noWindowManager).toBe(true);
  });
});
