// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationKeyAction,
  annotationSlideKey,
  trailOpacity,
  trailStrokeJoinsGroup,
  TRAIL_FADE_MS,
  TRAIL_HOLD_MS,
  type AnnotationCommand,
} from '../src/shared/annotations.js';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import type { PresentationCommand } from '../src/shared/ipc.js';
import { AnnotationLayer } from '../src/renderer/player/annotationLayer.js';
import { bindPresentKeys } from '../src/renderer/player/keys.js';
import type { Player } from '../src/renderer/player/player.js';
import { createSpeakerView } from '../src/renderer/presenter/speakerView.js';

/**
 * The presenter's pen, laser dot and laser trail. The pure half (timing, key
 * map) is checked directly; the layer is driven with real DOM pointer events
 * on a host of known size, and the two-surface mirroring is checked by
 * feeding one layer's commands into another.
 */

const key = (over: Partial<KeyboardEvent> & { key: string }) => ({
  metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
});

describe('annotation model', () => {
  it('holds a finished trail at full brightness, then fades it out', () => {
    expect(trailOpacity(0)).toBe(1);
    expect(trailOpacity(TRAIL_HOLD_MS)).toBe(1);
    const early = trailOpacity(TRAIL_HOLD_MS + TRAIL_FADE_MS * 0.25);
    const late = trailOpacity(TRAIL_HOLD_MS + TRAIL_FADE_MS * 0.75);
    expect(early).toBeLessThan(1);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(0);
    expect(trailOpacity(TRAIL_HOLD_MS + TRAIL_FADE_MS)).toBe(0);
    // The whole disappearance takes one to two seconds, as asked for.
    expect(TRAIL_HOLD_MS + TRAIL_FADE_MS).toBeGreaterThanOrEqual(1000);
    expect(TRAIL_HOLD_MS + TRAIL_FADE_MS).toBeLessThanOrEqual(2000);
  });

  it('keeps a word written in several strokes lit until the writer pauses', () => {
    expect(trailStrokeJoinsGroup(null, 5_000)).toBe(true);
    expect(trailStrokeJoinsGroup(1_000, 1_000 + TRAIL_HOLD_MS)).toBe(true);
    expect(trailStrokeJoinsGroup(1_000, 1_001 + TRAIL_HOLD_MS)).toBe(false);
  });

  it('maps P/L/T and 1/2/3 to the three tools, E to clear, Cmd/Ctrl+Z to undo', () => {
    expect(annotationKeyAction(key({ key: 'p' }), null)).toEqual({ kind: 'toggle', tool: 'pen' });
    expect(annotationKeyAction(key({ key: '1' }), null)).toEqual({ kind: 'toggle', tool: 'pen' });
    expect(annotationKeyAction(key({ key: 'L' }), null)).toEqual({ kind: 'toggle', tool: 'laser' });
    expect(annotationKeyAction(key({ key: '2' }), null)).toEqual({ kind: 'toggle', tool: 'laser' });
    expect(annotationKeyAction(key({ key: 't' }), null)).toEqual({ kind: 'toggle', tool: 'trail' });
    expect(annotationKeyAction(key({ key: '3' }), null)).toEqual({ kind: 'toggle', tool: 'trail' });
    expect(annotationKeyAction(key({ key: 'e' }), null)).toEqual({ kind: 'clear' });
    expect(annotationKeyAction(key({ key: 'z', metaKey: true }), null)).toEqual({ kind: 'undo' });
    expect(annotationKeyAction(key({ key: 'z', ctrlKey: true }), 'pen')).toEqual({ kind: 'undo' });
  });

  it('leaves Escape to end the show unless a tool is picked, and ignores shortcuts', () => {
    expect(annotationKeyAction(key({ key: 'Escape' }), null)).toBeNull();
    expect(annotationKeyAction(key({ key: 'Escape' }), 'trail')).toEqual({ kind: 'release' });
    expect(annotationKeyAction(key({ key: 'p', metaKey: true }), null)).toBeNull();
    expect(annotationKeyAction(key({ key: 'l', altKey: true }), null)).toBeNull();
    expect(annotationKeyAction(key({ key: 'z', metaKey: true, shiftKey: true }), null)).toBeNull();
    for (const other of ['ArrowRight', ' ', 'b', 'o', 'f', 'Enter']) {
      expect(annotationKeyAction(key({ key: other }), 'pen')).toBeNull();
    }
  });

  it('keys ink by slide id, so it follows a slide rather than a position', () => {
    const slides = [{ id: 'intro' }, { id: 'method' }];
    expect(annotationSlideKey(slides, 1)).toBe('method');
    expect(annotationSlideKey(slides, 7)).toBe('#7');
  });
});

/** A pointer event as Chromium sends it; jsdom has no PointerEvent class. */
function pointer(
  type: string,
  clientX: number,
  clientY: number,
  over: { button?: number; pointerId?: number } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    clientX, clientY, button: over.button ?? 0, bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, 'pointerId', { value: over.pointerId ?? 1 });
  return event;
}

/** A host laid out at 960×540 CSS pixels: a 16:9 slide with no letterbox. */
function hostOf(width = 960, height = 540): HTMLElement {
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
  });
  document.body.appendChild(host);
  return host;
}

describe('annotation layer', () => {
  let now: number;
  let frames: Array<() => void>;
  let sent: AnnotationCommand[];
  const layers: AnnotationLayer[] = [];

  const open = (host: HTMLElement, onCommand?: (command: AnnotationCommand) => void) => {
    const layer = new AnnotationLayer({
      host,
      canvas: { w: 1920, h: 1080 },
      onCommand: onCommand ?? ((command) => sent.push(command)),
      now: () => now,
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: () => {},
    });
    layers.push(layer);
    return layer;
  };

  const runFrames = () => {
    for (let guard = 0; guard < 100 && frames.length > 0; guard++) frames.shift()!();
  };

  beforeEach(() => {
    document.body.replaceChildren();
    // jsdom has no 2D canvas; the layer skips painting without one.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    now = 10_000;
    frames = [];
    sent = [];
  });

  afterEach(() => {
    for (const layer of layers.splice(0)) layer.destroy();
    vi.restoreAllMocks();
  });

  it('covers its host and asks the other surface for the show so far', () => {
    const host = hostOf();
    const layer = open(host);
    expect(host.querySelector('.annotation-layer')).toBe(layer.root);
    expect(layer.root.querySelectorAll('canvas')).toHaveLength(2);
    expect(sent).toEqual([{ kind: 'hello' }]);
  });

  it('draws pen ink in slide fractions and owns the button while picked', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setSlide('s1');
    layer.setTool('pen');
    expect(layer.capturesPointer()).toBe(true);
    expect(layer.root.classList.contains('annotation-drawing')).toBe(true);
    expect(host.classList.contains('annotation-active')).toBe(true);

    const down = pointer('pointerdown', 480, 270);
    host.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    host.dispatchEvent(pointer('pointermove', 720, 405));
    host.dispatchEvent(pointer('pointerup', 720, 405));

    expect(layer.inkFor('s1')).toEqual([[0.5, 0.5, 0.75, 0.75]]);
    expect(sent.map((command) => command.kind)).toEqual(['hello', 'tool', 'down', 'move', 'up']);
    expect(sent[2]).toMatchObject({ kind: 'down', tool: 'pen', slide: 's1', x: 0.5, y: 0.5 });
  });

  it('maps a letterboxed pointer onto the slide, not onto the window', () => {
    // 1200×540: the 960-wide slide sits 120px in from each side.
    const host = hostOf(1200, 540);
    const layer = open(host);
    layer.setTool('pen');
    host.dispatchEvent(pointer('pointerdown', 120, 0));
    host.dispatchEvent(pointer('pointermove', 1080, 540));
    host.dispatchEvent(pointer('pointerup', 1080, 540));
    expect(layer.inkFor()).toEqual([[0, 0, 1, 1]]);
  });

  it('mirrors every stroke onto another surface from the command stream', () => {
    const audienceHost = hostOf();
    const speakerHost = hostOf(480, 270);
    const audience = open(audienceHost);
    const speaker = open(speakerHost, (command) => audience.apply(command));
    audience.setSlide('s1');
    speaker.setSlide('s1');

    speaker.setTool('pen');
    speakerHost.dispatchEvent(pointer('pointerdown', 240, 135));
    speakerHost.dispatchEvent(pointer('pointermove', 360, 202.5));
    speakerHost.dispatchEvent(pointer('pointerup', 360, 202.5));

    // Drawn on a half-size preview, landing on the same spot of the slide.
    expect(audience.getTool()).toBe('pen');
    expect(audience.inkFor('s1')).toEqual(speaker.inkFor('s1'));
    expect(audience.inkFor('s1')).toEqual([[0.5, 0.5, 0.75, 0.75]]);
  });

  it('keeps ink with its slide and brings it back with the slide', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setSlide('a');
    layer.setTool('pen');
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointerup', 100, 100));
    layer.setSlide('b');
    expect(layer.inkFor()).toEqual([]);
    layer.setSlide('a');
    expect(layer.inkFor()).toHaveLength(1);
  });

  it('erases the slide with E and takes back one stroke with Cmd+Z', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setSlide('s1');
    layer.setTool('pen');
    for (const x of [100, 200, 300]) {
      host.dispatchEvent(pointer('pointerdown', x, 100));
      host.dispatchEvent(pointer('pointerup', x, 100));
    }
    expect(layer.inkFor()).toHaveLength(3);

    layer.handleKey(new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true }));
    expect(layer.inkFor()).toHaveLength(2);
    layer.handleKey(new KeyboardEvent('keydown', { key: 'e', cancelable: true }));
    expect(layer.inkFor()).toEqual([]);
    expect(sent.filter((command) => command.kind === 'clear')).toEqual([{ kind: 'clear', slide: 's1' }]);
  });

  it('fades a released trail out on its own, within two seconds', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setTool('trail');
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointermove', 300, 150));
    now += 2_000;
    // Still held: a trail stays however long the button is down.
    expect(layer.visibleTrailCount()).toBe(1);
    host.dispatchEvent(pointer('pointerup', 300, 150));

    now += TRAIL_HOLD_MS;
    runFrames();
    expect(layer.visibleTrailCount()).toBe(1);
    now += TRAIL_FADE_MS;
    runFrames();
    expect(layer.visibleTrailCount()).toBe(0);
    // Nothing left to animate, so the frame loop has stopped.
    expect(frames).toHaveLength(0);
  });

  it('keeps earlier trail strokes lit while the next one starts promptly', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setTool('trail');
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointerup', 120, 100));
    now += TRAIL_HOLD_MS / 2;
    host.dispatchEvent(pointer('pointerdown', 140, 100));
    host.dispatchEvent(pointer('pointerup', 160, 100));
    expect(layer.visibleTrailCount()).toBe(1);

    // A stroke begun after the pause starts a group of its own.
    now += TRAIL_HOLD_MS + 50;
    host.dispatchEvent(pointer('pointerdown', 200, 100));
    expect(layer.visibleTrailCount()).toBe(2);
  });

  it('turns the pointer into a laser dot without taking the click', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setTool('laser');
    expect(layer.capturesPointer()).toBe(false);
    expect(layer.root.classList.contains('annotation-drawing')).toBe(false);
    expect(layer.pointerVisible()).toBe(false);

    host.dispatchEvent(pointer('pointermove', 480, 270));
    expect(layer.pointerVisible()).toBe(true);
    const down = pointer('pointerdown', 480, 270);
    host.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(layer.inkFor()).toEqual([]);

    host.dispatchEvent(pointer('pointerleave', 0, 0));
    expect(layer.pointerVisible()).toBe(false);
  });

  it('shows the dot where the pointer already is when a tool is picked', () => {
    const host = hostOf();
    const layer = open(host);
    host.dispatchEvent(pointer('pointermove', 480, 270));
    expect(sent.filter((command) => command.kind === 'move')).toEqual([]);
    layer.setTool('laser');
    expect(layer.pointerVisible()).toBe(true);
    expect(sent.at(-1)).toEqual({ kind: 'move', points: [0.5, 0.5] });
  });

  it('drops a picked tool on Escape and leaves Escape alone otherwise', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setTool('pen');
    expect(layer.handleKey(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))).toBe(true);
    expect(layer.getTool()).toBeNull();
    expect(host.classList.contains('annotation-active')).toBe(false);
    expect(layer.handleKey(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))).toBe(false);
  });

  it('toggles a tool off with its own key and ignores key repeat', () => {
    const host = hostOf();
    const layer = open(host);
    layer.handleKey(new KeyboardEvent('keydown', { key: 't', cancelable: true }));
    expect(layer.getTool()).toBe('trail');
    layer.handleKey(new KeyboardEvent('keydown', { key: 't', repeat: true, cancelable: true }));
    expect(layer.getTool()).toBe('trail');
    layer.handleKey(new KeyboardEvent('keydown', { key: 't', cancelable: true }));
    expect(layer.getTool()).toBeNull();
  });

  it('hands a late surface the ink and tool drawn before it opened', () => {
    const audienceHost = hostOf();
    const audience = open(audienceHost);
    audience.setSlide('s1');
    audience.setTool('pen');
    audienceHost.dispatchEvent(pointer('pointerdown', 100, 100));
    audienceHost.dispatchEvent(pointer('pointerup', 200, 100));

    // A Speaker View opening now says hello, which its transport delivers to
    // the audience; the audience answers through its own transport (`sent`).
    const speaker = open(hostOf(), (command) => audience.apply(command));
    const snapshot = sent.find((command) => command.kind === 'snapshot');
    expect(snapshot).toBeDefined();
    speaker.apply(snapshot!);
    speaker.setSlide('s1');

    expect(speaker.inkFor('s1')).toEqual(audience.inkFor('s1'));
    expect(speaker.getTool()).toBe('pen');
  });

  it('never lets a snapshot erase ink the receiving surface already has', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setSlide('s1');
    layer.setTool('pen');
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointerup', 100, 100));
    const mine = layer.inkFor('s1');
    layer.apply({ kind: 'snapshot', tool: 'laser', ink: { s1: [[0.9, 0.9]], s2: [[0.1, 0.1]] } });
    expect(layer.inkFor('s1')).toEqual(mine);
    expect(layer.inkFor('s2')).toEqual([[0.1, 0.1]]);
    expect(layer.getTool()).toBe('pen');
  });

  it('hides ink while the screen is blanked, without losing it', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setSlide('s1');
    layer.setTool('pen');
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    host.dispatchEvent(pointer('pointerup', 100, 100));
    layer.setHidden(true);
    layer.setHidden(false);
    expect(layer.inkFor()).toHaveLength(1);
  });

  it('removes itself and its listeners when destroyed', () => {
    const host = hostOf();
    const layer = open(host);
    layer.setTool('pen');
    layer.destroy();
    expect(host.querySelector('.annotation-layer')).toBeNull();
    expect(host.classList.contains('annotation-active')).toBe(false);
    host.dispatchEvent(pointer('pointerdown', 100, 100));
    expect(layer.inkFor()).toEqual([]);
  });
});

describe('annotation keys in the presenting key map', () => {
  it('lets annotations claim a key before the show acts on it', () => {
    const onExit = vi.fn();
    const onNext = vi.fn();
    let claimEscape = true;
    const unbind = bindPresentKeys(window, {} as Player, {
      intercept: (event) => event.key === 'Escape' && claimEscape,
      onExit,
      onNext,
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(onExit).not.toHaveBeenCalled();
    claimEscape = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(onExit).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(onNext).toHaveBeenCalledTimes(1);
    unbind();
  });
});

describe('speaker view annotation tools', () => {
  function deckOf(count: number): Deck {
    return parseDeck({
      ...emptyDeck('Talk'),
      slides: Array.from({ length: count }, (_, index) => ({
        id: `s${index + 1}`,
        elements: [],
      })),
    });
  }

  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it('offers the three tools and sends what the presenter picks', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const annotations: AnnotationCommand[] = [];
    const commands: PresentationCommand[] = [];
    const view = createSpeakerView({
      host,
      resolveSrc: (src) => src,
      onCommand: (command) => commands.push(command),
      onAnnotation: (command) => annotations.push(command),
    });
    view.setDeck(deckOf(2));

    const tools = [...host.querySelectorAll<HTMLButtonElement>('.speaker-tool')];
    expect(tools.map((button) => button.dataset.tool)).toEqual(['pen', 'laser', 'trail']);
    // The drawing surface sits over the current-slide preview.
    expect(host.querySelector('.speaker-current .annotation-layer')).not.toBeNull();

    tools[0].click();
    expect(annotations.at(-1)).toEqual({ kind: 'tool', tool: 'pen' });
    expect(tools[0].getAttribute('aria-pressed')).toBe('true');

    // A tool picked on the audience surface shows here too.
    view.annotate({ kind: 'tool', tool: 'trail' });
    expect(tools[0].getAttribute('aria-pressed')).toBe('false');
    expect(tools[2].getAttribute('aria-pressed')).toBe('true');

    host.querySelector<HTMLButtonElement>('.speaker-clear-ink')!.click();
    expect(annotations.at(-1)).toEqual({ kind: 'clear', slide: 's1' });

    // Escape drops the tool first; only then does it end the show.
    expect(view.handleAnnotationKey(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })))
      .toBe(true);
    expect(tools[2].getAttribute('aria-pressed')).toBe('false');
    expect(commands).toEqual([]);
    view.destroy();
  });

  it('keeps the drawing surface over the preview as slides change', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createSpeakerView({
      host,
      resolveSrc: (src) => src,
      onCommand: () => {},
      onAnnotation: () => {},
    });
    view.setDeck(deckOf(3));
    view.setState({ cursor: { slide: 1, step: 0 }, steps: 1, startedAt: 0, slideStartedAt: 0 });
    view.setState({ cursor: { slide: 2, step: 0 }, steps: 1, startedAt: 0, slideStartedAt: 0 });
    expect(host.querySelectorAll('.speaker-current .annotation-layer')).toHaveLength(1);
    view.destroy();
  });

  it('has no annotation tools when the shell cannot relay them', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createSpeakerView({ host, resolveSrc: (src) => src, onCommand: () => {} });
    expect(host.querySelector('.speaker-tools')).toBeNull();
    expect(host.querySelector('.annotation-layer')).toBeNull();
    view.destroy();
  });
});
