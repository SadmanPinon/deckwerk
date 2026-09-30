import {
  annotationKeyAction,
  trailOpacity,
  trailStrokeJoinsGroup,
  TRAIL_FADE_MS,
  TRAIL_HOLD_MS,
  type AnnotationCommand,
  type AnnotationTool,
  type StrokePoints,
} from '@shared/annotations.js';
import { fitScale } from '@shared/geometry.js';

/**
 * The presenter's pen, laser dot and laser trail, drawn over a presenting
 * surface (see `@shared/annotations` for the model and the command stream).
 *
 * Two canvases stacked over the slide: ink, repainted only when a stroke
 * changes, and effects (the trails and the pointer), repainted every frame
 * while something is moving or fading and not at all otherwise. Sizes are
 * fractions of the slide's width, so the projector and a Speaker View preview
 * draw the same picture at their own scale.
 */

export interface AnnotationLayerOptions {
  /** The element the slide is letterboxed into. The layer covers it exactly. */
  host: HTMLElement;
  /** The deck's canvas, which fixes where the slide sits inside `host`. */
  canvas: { w: number; h: number };
  /** Take pointer input on this surface. Off for a display-only mirror. */
  interactive?: boolean;
  /** Every command this surface produces, for the shell to forward. */
  onCommand?: (command: AnnotationCommand) => void;
  /** Tool changes from either surface, so a shell can reflect them in controls. */
  onToolChange?: (tool: AnnotationTool | null) => void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

/** Stroke and dot sizes, as fractions of the slide's rendered width. */
const PEN_WIDTH = 0.0026;
const TRAIL_WIDTH = 0.0072;
const TRAIL_CORE = 0.0026;
const TRAIL_GLOW = 0.008;
const DOT_RADIUS = 0.005;

const PEN_COLOR = '#e8182c';
const LASER_RED = '#ff1a1a';
const LASER_GLOW = 'rgba(255, 24, 24, 0.95)';

interface Stroke {
  points: StrokePoints;
}

interface TrailGroup {
  strokes: Stroke[];
  /** When the newest stroke ended; null while one is still being drawn. */
  releasedAt: number | null;
}

/** Where the slide sits in canvas pixels (device pixels, not CSS pixels). */
interface Metrics {
  dpr: number;
  width: number;
  height: number;
  left: number;
  top: number;
  w: number;
  h: number;
}

export class AnnotationLayer {
  readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly inkCanvas: HTMLCanvasElement;
  private readonly fxCanvas: HTMLCanvasElement;
  private readonly interactive: boolean;
  private readonly options: AnnotationLayerOptions;
  private readonly now: () => number;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly resizeObserver: ResizeObserver | null;

  private canvas: { w: number; h: number };
  private tool: AnnotationTool | null = null;
  private slide = '';
  private hidden = false;
  private ink = new Map<string, Stroke[]>();
  private activePen: Stroke | null = null;
  private trails: TrailGroup[] = [];
  private activeTrail: TrailGroup | null = null;
  /** Where the laser dot or pen tip is, in slide fractions; null hides it. */
  private pointer: { x: number; y: number } | null = null;
  /** The last pointer position over this surface, so a newly picked tool appears under it. */
  private lastClient: { x: number; y: number } | null = null;
  private capturedPointer: number | null = null;
  private inkDirty = true;
  private frame: number | null = null;
  private destroyed = false;

  constructor(options: AnnotationLayerOptions) {
    this.options = options;
    this.host = options.host;
    this.canvas = options.canvas;
    this.interactive = options.interactive ?? true;
    this.now = options.now ?? (() => performance.now());
    this.requestFrame = options.requestFrame
      ?? ((callback) => (typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(callback)
        : window.setTimeout(callback, 16)));
    this.cancelFrame = options.cancelFrame
      ?? ((handle) => (typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame(handle)
        : window.clearTimeout(handle)));

    this.root = document.createElement('div');
    this.root.className = 'annotation-layer';
    this.root.setAttribute('aria-hidden', 'true');
    this.inkCanvas = document.createElement('canvas');
    this.inkCanvas.className = 'annotation-ink';
    this.fxCanvas = document.createElement('canvas');
    this.fxCanvas.className = 'annotation-effects';
    this.root.append(this.inkCanvas, this.fxCanvas);
    this.host.append(this.root);

    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.invalidate())
      : null;
    this.resizeObserver?.observe(this.host);

    if (this.interactive) {
      this.host.addEventListener('pointerdown', this.onPointerDown);
      this.host.addEventListener('pointermove', this.onPointerMove);
      this.host.addEventListener('pointerup', this.onPointerUp);
      this.host.addEventListener('pointercancel', this.onPointerUp);
      this.host.addEventListener('lostpointercapture', this.onPointerUp);
      this.host.addEventListener('pointerleave', this.onPointerLeave);
    }
    // Ask the other surface for anything drawn before this one opened.
    this.options.onCommand?.({ kind: 'hello' });
  }

  getTool(): AnnotationTool | null {
    return this.tool;
  }

  /** Pen and trail own the primary button, so a click must not also advance. */
  capturesPointer(): boolean {
    return this.tool === 'pen' || this.tool === 'trail';
  }

  /** Pen strokes on one slide, as slide fractions. For tests and diagnostics. */
  inkFor(slide: string = this.slide): StrokePoints[] {
    return (this.ink.get(slide) ?? []).map((stroke) => [...stroke.points]);
  }

  /** Trail groups still on screen. For tests and diagnostics. */
  visibleTrailCount(): number {
    this.pruneTrails(this.now());
    return this.trails.length;
  }

  /** Whether the laser dot or pen tip is showing. */
  pointerVisible(): boolean {
    return this.tool !== null && this.pointer !== null;
  }

  setTool(tool: AnnotationTool | null): void {
    if (tool === this.tool) return;
    this.emit({ kind: 'tool', tool });
    // Show the dot where the pointer already is, rather than after it moves.
    if (tool && this.lastClient) {
      this.emit({ kind: 'move', points: this.toFraction(this.lastClient.x, this.lastClient.y) });
    }
  }

  toggleTool(tool: AnnotationTool): void {
    this.setTool(this.tool === tool ? null : tool);
  }

  clearSlide(): void {
    this.emit({ kind: 'clear', slide: this.slide });
  }

  undo(): void {
    this.emit({ kind: 'undo', slide: this.slide });
  }

  /**
   * First refusal on a presenting key. Returns true when the key was an
   * annotation key and has been handled, so the shell skips its own mapping.
   */
  handleKey(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return false;
    }
    const action = annotationKeyAction(event, this.tool);
    if (!action) return false;
    event.preventDefault();
    // Holding a tool key must not flicker the tool on and off.
    if (event.repeat && action.kind === 'toggle') return true;
    if (action.kind === 'toggle') this.toggleTool(action.tool);
    else if (action.kind === 'clear') this.clearSlide();
    else if (action.kind === 'undo') this.undo();
    else this.setTool(null);
    return true;
  }

  /** The slide now on screen, by its key (`annotationSlideKey`). */
  setSlide(slide: string): void {
    if (slide === this.slide) return;
    this.slide = slide;
    // A trail belongs to the moment it was drawn; it does not follow the talk
    // onto the next slide. Ink stays with its own slide and returns with it.
    this.trails = this.trails.filter((group) => group === this.activeTrail);
    this.inkDirty = true;
    this.schedule();
  }

  setCanvas(canvas: { w: number; h: number }): void {
    if (canvas.w === this.canvas.w && canvas.h === this.canvas.h) return;
    this.canvas = canvas;
    this.invalidate();
  }

  /** Hide the ink while the presentation is blanked; it returns with the slide. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.inkDirty = true;
    this.schedule();
  }

  /** Put the layer back after the host's children were replaced. */
  attach(): void {
    if (this.root.parentNode !== this.host) {
      this.host.append(this.root);
      this.invalidate();
    }
  }

  /** Apply a command from the other surface (or from this one, via `emit`). */
  apply(command: AnnotationCommand): void {
    if (this.destroyed) return;
    switch (command.kind) {
      case 'tool': {
        if (command.tool === this.tool) return;
        this.finishStroke();
        this.releaseCapture();
        this.tool = command.tool;
        if (command.tool === null) this.pointer = null;
        this.syncInteraction();
        this.options.onToolChange?.(command.tool);
        break;
      }
      case 'down': {
        this.finishStroke();
        this.pointer = { x: command.x, y: command.y };
        const stroke: Stroke = { points: [command.x, command.y] };
        if (command.tool === 'pen') {
          const strokes = this.ink.get(command.slide) ?? [];
          strokes.push(stroke);
          this.ink.set(command.slide, strokes);
          this.activePen = stroke;
          this.inkDirty = true;
        } else if (command.tool === 'trail') {
          const now = this.now();
          let group = this.trails.at(-1);
          if (!group || !trailStrokeJoinsGroup(group.releasedAt, now)) {
            group = { strokes: [], releasedAt: null };
            this.trails.push(group);
          }
          group.releasedAt = null;
          group.strokes.push(stroke);
          this.activeTrail = group;
        }
        break;
      }
      case 'move': {
        const points = command.points;
        if (points.length < 2) return;
        this.pointer = { x: points[points.length - 2], y: points[points.length - 1] };
        if (this.activePen) {
          this.activePen.points.push(...points);
          this.inkDirty = true;
        } else if (this.activeTrail) {
          this.activeTrail.strokes.at(-1)?.points.push(...points);
        }
        break;
      }
      case 'up':
        this.finishStroke();
        break;
      case 'leave':
        this.pointer = null;
        break;
      case 'clear': {
        const strokes = this.ink.get(command.slide);
        if (this.activePen && strokes?.includes(this.activePen)) this.activePen = null;
        this.ink.delete(command.slide);
        this.inkDirty = true;
        break;
      }
      case 'undo': {
        const removed = this.ink.get(command.slide)?.pop();
        if (removed && removed === this.activePen) this.activePen = null;
        this.inkDirty = true;
        break;
      }
      case 'hello':
        // Answer, never re-announce: a hello answered with a hello would
        // bounce between the two surfaces forever.
        this.options.onCommand?.({ kind: 'snapshot', tool: this.tool, ink: this.serializeInk() });
        return;
      case 'snapshot': {
        // Adopt only what this surface does not already have, so a snapshot
        // can never erase ink drawn here in the meantime.
        for (const [slide, strokes] of Object.entries(command.ink)) {
          if (strokes.length === 0 || this.ink.get(slide)?.length) continue;
          this.ink.set(slide, strokes.map((points) => ({ points: [...points] })));
          this.inkDirty = true;
        }
        if (this.tool === null && command.tool !== null) {
          this.apply({ kind: 'tool', tool: command.tool });
        }
        break;
      }
    }
    this.schedule();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.resizeObserver?.disconnect();
    this.host.removeEventListener('pointerdown', this.onPointerDown);
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerup', this.onPointerUp);
    this.host.removeEventListener('pointercancel', this.onPointerUp);
    this.host.removeEventListener('lostpointercapture', this.onPointerUp);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    this.host.classList.remove('annotation-active');
    this.root.remove();
  }

  /* --- input ---------------------------------------------------------------- */

  private emit(command: AnnotationCommand): void {
    this.apply(command);
    this.options.onCommand?.(command);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.lastClient = { x: event.clientX, y: event.clientY };
    const tool = this.tool;
    if (event.button !== 0 || (tool !== 'pen' && tool !== 'trail')) return;
    event.preventDefault();
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event has no pointer to capture; drawing still works.
    }
    this.capturedPointer = event.pointerId;
    const [x, y] = this.toFraction(event.clientX, event.clientY);
    this.emit({ kind: 'down', tool, slide: this.slide, x, y });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.lastClient = { x: event.clientX, y: event.clientY };
    if (!this.tool) return;
    if (this.capturedPointer !== null && event.pointerId !== this.capturedPointer) return;
    // While drawing, take every sample the browser merged into this event, or
    // fast strokes come out as straight segments.
    const samples = this.capturedPointer !== null && typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : [];
    const points: StrokePoints = [];
    for (const sample of samples.length > 0 ? samples : [event]) {
      points.push(...this.toFraction(sample.clientX, sample.clientY));
    }
    this.emit({ kind: 'move', points });
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.capturedPointer === null || event.pointerId !== this.capturedPointer) return;
    this.releaseCapture();
    this.emit({ kind: 'up' });
  };

  private readonly onPointerLeave = (): void => {
    this.lastClient = null;
    if (this.capturedPointer !== null || !this.tool) return;
    this.emit({ kind: 'leave' });
  };

  private releaseCapture(): void {
    const pointer = this.capturedPointer;
    if (pointer === null) return;
    this.capturedPointer = null;
    try {
      if (this.host.hasPointerCapture?.(pointer)) this.host.releasePointerCapture(pointer);
    } catch {
      // Already released by the browser.
    }
  }

  /** Viewport point → slide fractions, inverting the same fit the Player uses. */
  private toFraction(clientX: number, clientY: number): [number, number] {
    const rect = this.host.getBoundingClientRect();
    const scale = fitScale(this.canvas, { w: rect.width, h: rect.height }) || 1;
    const w = this.canvas.w * scale;
    const h = this.canvas.h * scale;
    const left = rect.left + (rect.width - w) / 2;
    const top = rect.top + (rect.height - h) / 2;
    return [round((clientX - left) / w), round((clientY - top) / h)];
  }

  private syncInteraction(): void {
    const drawing = this.interactive && this.capturesPointer();
    this.root.classList.toggle('annotation-drawing', drawing);
    this.host.classList.toggle('annotation-active', this.interactive && this.tool !== null);
  }

  private finishStroke(): void {
    if (this.activeTrail) this.activeTrail.releasedAt = this.now();
    this.activeTrail = null;
    this.activePen = null;
  }

  private serializeInk(): Record<string, StrokePoints[]> {
    const out: Record<string, StrokePoints[]> = {};
    for (const [slide, strokes] of this.ink) {
      if (strokes.length > 0) out[slide] = strokes.map((stroke) => [...stroke.points]);
    }
    return out;
  }

  /* --- drawing -------------------------------------------------------------- */

  private invalidate(): void {
    this.inkDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== null || this.destroyed) return;
    this.frame = this.requestFrame(this.paint);
  }

  private readonly paint = (): void => {
    this.frame = null;
    if (this.destroyed) return;
    const metrics = this.metrics();
    if (!metrics) return;
    if (this.fit(metrics)) this.inkDirty = true;
    const now = this.now();
    this.pruneTrails(now);
    if (this.inkDirty) this.paintInk(metrics);
    // Keep painting while a trail is lit or fading; stop once nothing moves.
    if (this.paintEffects(metrics, now)) this.schedule();
  };

  private pruneTrails(now: number): void {
    this.trails = this.trails.filter((group) =>
      group.releasedAt === null || now - group.releasedAt < TRAIL_HOLD_MS + TRAIL_FADE_MS);
  }

  private metrics(): Metrics | null {
    const rect = this.host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const scale = fitScale(this.canvas, { w: rect.width, h: rect.height });
    const w = this.canvas.w * scale * dpr;
    const h = this.canvas.h * scale * dpr;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    return { dpr, width, height, left: (width - w) / 2, top: (height - h) / 2, w, h };
  }

  /** Match both canvases to the host's device-pixel size. True when either changed. */
  private fit(metrics: Metrics): boolean {
    let changed = false;
    for (const canvas of [this.inkCanvas, this.fxCanvas]) {
      if (canvas.width !== metrics.width || canvas.height !== metrics.height) {
        canvas.width = metrics.width;
        canvas.height = metrics.height;
        changed = true;
      }
    }
    return changed;
  }

  private paintInk(metrics: Metrics): void {
    this.inkDirty = false;
    const ctx = this.inkCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, metrics.width, metrics.height);
    const strokes = this.ink.get(this.slide);
    if (this.hidden || !strokes?.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PEN_COLOR;
    ctx.lineWidth = Math.max(PEN_WIDTH * metrics.w, 1.5 * metrics.dpr);
    ctx.beginPath();
    for (const stroke of strokes) tracePath(ctx, stroke.points, metrics);
    ctx.stroke();
    ctx.restore();
  }

  /** Paint trails and the pointer. True while a trail still needs frames. */
  private paintEffects(metrics: Metrics, now: number): boolean {
    const ctx = this.fxCanvas.getContext('2d');
    if (!ctx) return this.trails.length > 0;
    ctx.clearRect(0, 0, metrics.width, metrics.height);
    for (const group of this.trails) {
      const opacity = group.releasedAt === null ? 1 : trailOpacity(now - group.releasedAt);
      if (opacity > 0) paintTrail(ctx, group, opacity, metrics);
    }
    if (this.tool && this.pointer) {
      const x = metrics.left + this.pointer.x * metrics.w;
      const y = metrics.top + this.pointer.y * metrics.h;
      if (this.tool === 'laser') paintDot(ctx, x, y, metrics, 1);
      // While a stroke is being drawn its own head shows where the pointer is.
      else if (this.tool === 'trail' && !this.activeTrail) paintDot(ctx, x, y, metrics, 0.8);
      else if (this.tool === 'pen' && !this.activePen) paintPenTip(ctx, x, y, metrics);
    }
    return this.trails.length > 0;
  }
}

function round(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

/** Add one stroke to the current path, smoothed through the midpoints of its samples. */
function tracePath(ctx: CanvasRenderingContext2D, points: StrokePoints, metrics: Metrics): void {
  const count = Math.floor(points.length / 2);
  if (count === 0) return;
  const x = (index: number) => metrics.left + points[index * 2] * metrics.w;
  const y = (index: number) => metrics.top + points[index * 2 + 1] * metrics.h;
  ctx.moveTo(x(0), y(0));
  if (count === 1) {
    // A tap: a zero-length segment with round caps paints a dot, but only
    // when it is not quite zero-length.
    ctx.lineTo(x(0) + 0.01, y(0));
    return;
  }
  for (let index = 1; index < count - 1; index++) {
    ctx.quadraticCurveTo(x(index), y(index), (x(index) + x(index + 1)) / 2, (y(index) + y(index + 1)) / 2);
  }
  ctx.lineTo(x(count - 1), y(count - 1));
}

/** The laser trail: a red body with a soft glow and a white-hot core. */
function paintTrail(
  ctx: CanvasRenderingContext2D,
  group: TrailGroup,
  opacity: number,
  metrics: Metrics,
): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const stroke of group.strokes) tracePath(ctx, stroke.points, metrics);
  ctx.shadowColor = LASER_GLOW;
  ctx.shadowBlur = Math.max(TRAIL_GLOW * metrics.w, 6 * metrics.dpr);
  ctx.strokeStyle = LASER_RED;
  ctx.lineWidth = Math.max(TRAIL_WIDTH * metrics.w, 3 * metrics.dpr);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(TRAIL_CORE * metrics.w, 1.2 * metrics.dpr);
  ctx.stroke();
  ctx.restore();
}

/** The laser dot: a red disc with a white centre and a halo. */
function paintDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  metrics: Metrics,
  scale: number,
): void {
  const radius = Math.max(DOT_RADIUS * metrics.w, 4 * metrics.dpr) * scale;
  const halo = radius * 3;
  const glow = ctx.createRadialGradient(x, y, radius * 0.6, x, y, halo);
  glow.addColorStop(0, 'rgba(255, 32, 32, 0.45)');
  glow.addColorStop(1, 'rgba(255, 32, 32, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, halo, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = LASER_RED;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.36, 0, Math.PI * 2);
  ctx.fill();
}

/** Where the pen will draw, with a pale rim so it reads on dark slides too. */
function paintPenTip(ctx: CanvasRenderingContext2D, x: number, y: number, metrics: Metrics): void {
  const radius = Math.max(PEN_WIDTH * metrics.w, 1.5 * metrics.dpr) * 0.75 + metrics.dpr;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = PEN_COLOR;
  ctx.fill();
  ctx.lineWidth = metrics.dpr;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke();
}
