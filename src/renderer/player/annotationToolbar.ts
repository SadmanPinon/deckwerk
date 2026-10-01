import { ANNOTATION_TOOLS, type AnnotationTool } from '@shared/annotations.js';
import type { AnnotationLayer } from './annotationLayer.js';

/**
 * On-screen buttons for the presenter's pen and lasers, so nobody has to
 * remember the keys. Each button carries its key as a small badge, which is
 * how the keys get learned.
 *
 * The toolbar sits in the bottom-left corner and stays out of the talk: it is
 * invisible until the pointer moves, and fades again once the pointer rests. A
 * talk driven from the keyboard or a clicker never shows it. While a tool is
 * picked, pointing and drawing move the pointer constantly, so then only a
 * move into the corner brings the buttons back.
 */

type ButtonId = AnnotationTool | 'undo' | 'clear';

export interface AnnotationToolbarOptions {
  /** Where the toolbar goes; it positions itself over the whole window. */
  parent: HTMLElement;
  layer: AnnotationLayer;
  /** How long the controls stay after the pointer comes to rest. */
  idleMs?: number;
}

/** Corner reach: a move this close to the toolbar reveals it with a tool picked. */
const HOT_ZONE_PX = 96;
const IDLE_MS = 2_500;

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const BUTTONS: Array<{ id: ButtonId; label: string; key: string }> = [
  { id: 'pen', label: 'Pen', key: 'P' },
  { id: 'laser', label: 'Laser dot', key: 'L' },
  { id: 'trail', label: 'Laser trail', key: 'T' },
  { id: 'undo', label: 'Undo last stroke', key: MAC ? '⌘Z' : 'Ctrl+Z' },
  { id: 'clear', label: "Clear this slide's ink", key: 'E' },
];

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const ICONS: Record<ButtonId, string> = {
  pen: `<svg ${SVG_ATTRS}><path d="M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 3L8.2 18.4 4 20z"/><path d="M13.8 6.8l3 3"/></svg>`,
  laser: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="7.5" opacity=".4"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>`,
  trail: `<svg ${SVG_ATTRS}><path d="M3 17c2.6-.2 3.4-4.6 6-4.6s2.6 3.2 5 3.2 3-4.4 4.6-6.6" opacity=".55"/><circle cx="19.4" cy="7.8" r="2.2" fill="currentColor"/></svg>`,
  undo: `<svg ${SVG_ATTRS}><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`,
  clear: `<svg ${SVG_ATTRS}><path d="M8.5 19.5L4.2 15.2a1.6 1.6 0 0 1 0-2.3l8.7-8.7a1.6 1.6 0 0 1 2.3 0l4.6 4.6a1.6 1.6 0 0 1 0 2.3L12.3 19.5"/><path d="M8.5 19.5H20"/><path d="M9 8.6l6.4 6.4"/></svg>`,
};

export class AnnotationToolbar {
  readonly element: HTMLElement;
  private readonly parent: HTMLElement;
  private readonly layer: AnnotationLayer;
  private readonly idleMs: number;
  private readonly buttons = new Map<ButtonId, HTMLButtonElement>();
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private hovered = false;

  constructor(options: AnnotationToolbarOptions) {
    this.parent = options.parent;
    this.layer = options.layer;
    this.idleMs = options.idleMs ?? IDLE_MS;

    this.element = document.createElement('div');
    this.element.className = 'annotation-toolbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Annotation tools');
    for (const { id, label, key } of BUTTONS) {
      if (id === 'undo') {
        const divider = document.createElement('span');
        divider.className = 'annotation-toolbar-divider';
        this.element.append(divider);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'annotation-tool';
      button.dataset.action = id;
      // Never take keyboard focus: Space and Enter must keep advancing the
      // slides, not press whichever button was clicked last.
      button.tabIndex = -1;
      button.title = (ANNOTATION_TOOLS as readonly string[]).includes(id)
        ? `${label} (${key}). Click again to put it down.`
        : `${label} (${key})`;
      button.setAttribute('aria-label', label);
      if ((ANNOTATION_TOOLS as readonly string[]).includes(id)) button.setAttribute('aria-pressed', 'false');
      button.innerHTML = `${ICONS[id]}<kbd>${key}</kbd>`;
      button.addEventListener('click', () => this.press(id));
      this.buttons.set(id, button);
      this.element.append(button);
    }
    this.parent.append(this.element);

    window.addEventListener('pointermove', this.onWindowPointerMove);
    this.element.addEventListener('pointerenter', this.onEnter);
    this.element.addEventListener('pointerleave', this.onLeave);
    // A press on the toolbar is not a press on the slide: it must not advance,
    // go back, toggle fullscreen or start a stroke underneath.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      this.element.addEventListener(type, this.swallow);
    }
    this.reflect(this.layer.getTool());
  }

  /** Show which tool is picked, whichever surface or key picked it. */
  reflect(tool: AnnotationTool | null): void {
    for (const id of ANNOTATION_TOOLS) {
      this.buttons.get(id)?.setAttribute('aria-pressed', String(id === tool));
    }
  }

  isVisible(): boolean {
    return this.element.classList.contains('visible');
  }

  /** Bring the controls (and the pointer) up until the pointer rests again. */
  reveal(): void {
    this.element.classList.add('visible');
    this.parent.classList.add('annotation-controls-visible');
    this.scheduleHide();
  }

  destroy(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    this.parent.classList.remove('annotation-controls-visible');
    this.element.remove();
  }

  private press(id: ButtonId): void {
    if (id === 'undo') this.layer.undo();
    else if (id === 'clear') this.layer.clearSlide();
    else this.layer.toggleTool(id);
  }

  private readonly swallow = (event: Event): void => {
    event.stopPropagation();
    // Keep focus and text selection where they were.
    if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'contextmenu') {
      event.preventDefault();
    }
  };

  private readonly onWindowPointerMove = (event: PointerEvent): void => {
    // A stroke in progress never summons the controls.
    if (event.buttons !== 0) return;
    if (this.layer.getTool() === null || this.nearToolbar(event.clientX, event.clientY)) this.reveal();
  };

  private readonly onEnter = (): void => {
    this.hovered = true;
    this.reveal();
  };

  private readonly onLeave = (): void => {
    this.hovered = false;
    this.scheduleHide();
  };

  private nearToolbar(x: number, y: number): boolean {
    const rect = this.element.getBoundingClientRect();
    return x >= rect.left - HOT_ZONE_PX && x <= rect.right + HOT_ZONE_PX
      && y >= rect.top - HOT_ZONE_PX && y <= rect.bottom + HOT_ZONE_PX;
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      // Leaving the toolbar starts the clock again.
      if (this.hovered) return;
      this.element.classList.remove('visible');
      this.parent.classList.remove('annotation-controls-visible');
    }, this.idleMs);
  }
}
