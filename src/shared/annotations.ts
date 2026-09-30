/**
 * Presenter annotations: a red pen, a laser dot, and a laser trail that fades
 * once the presenter stops drawing.
 *
 * Nothing here is part of the deck. Ink lives for the length of one show and
 * never reaches deck.json, History or collaborators. What does travel is the
 * command stream below: every surface that shows the presentation (the
 * audience window and Speaker View's current-slide preview) runs the same
 * layer, input on either one becomes these commands, and the other applies
 * them too. Neither surface owns the other, so drawing works from whichever
 * one the presenter's pointer happens to be on.
 *
 * Points are fractions of the slide, measured from its top-left corner (0..1
 * on each axis, outside that range in the letterbox), so a stroke drawn on a
 * small preview lands in the same place on the projector.
 */

export type AnnotationTool = 'pen' | 'laser' | 'trail';

export const ANNOTATION_TOOLS: readonly AnnotationTool[] = ['pen', 'laser', 'trail'];

/** One pen stroke or trail stroke: flat slide fractions, `[x0, y0, x1, y1, …]`. */
export type StrokePoints = number[];

export type AnnotationCommand =
  /** Select a tool, or `null` to return to the ordinary presenting pointer. */
  | { kind: 'tool'; tool: AnnotationTool | null }
  /**
   * The primary button went down. Starts a pen stroke or a laser trail; the
   * tool travels with it so a stroke never depends on the receiver's tool
   * having caught up.
   */
  | { kind: 'down'; tool: AnnotationTool; slide: string; x: number; y: number }
  /** Pointer motion, pressed or hovering, with every coalesced sample. */
  | { kind: 'move'; points: StrokePoints }
  | { kind: 'up' }
  /** The pointer left the surface: hide the laser dot and the pen tip. */
  | { kind: 'leave' }
  /** Erase every pen stroke on one slide. */
  | { kind: 'clear'; slide: string }
  /** Remove the newest pen stroke on one slide. */
  | { kind: 'undo'; slide: string }
  /** A surface that just opened asks the other for the show so far. */
  | { kind: 'hello' }
  /** The answer to `hello`: the current tool and every slide's ink. */
  | { kind: 'snapshot'; tool: AnnotationTool | null; ink: Record<string, StrokePoints[]> };

/** How long a finished laser trail stays fully lit before it starts to fade. */
export const TRAIL_HOLD_MS = 600;
/** How long the fade itself takes once it starts. */
export const TRAIL_FADE_MS = 900;

/**
 * Opacity of a laser trail `elapsed` milliseconds after its last stroke ended.
 * Full brightness through the hold, then an eased fade to nothing.
 */
export function trailOpacity(
  elapsed: number,
  hold: number = TRAIL_HOLD_MS,
  fade: number = TRAIL_FADE_MS,
): number {
  if (elapsed <= hold) return 1;
  if (elapsed >= hold + fade) return 0;
  const t = (elapsed - hold) / fade;
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Whether a new trail stroke starting now still joins the previous one. A word
 * written in several strokes stays lit as long as each stroke begins before
 * the previous group has started fading, which is how the tablet apps behave.
 */
export function trailStrokeJoinsGroup(
  releasedAt: number | null,
  now: number,
  hold: number = TRAIL_HOLD_MS,
): boolean {
  return releasedAt === null || now - releasedAt <= hold;
}

export type AnnotationKeyAction =
  /** Toggle this tool: select it, or drop it when it is already selected. */
  | { kind: 'toggle'; tool: AnnotationTool }
  | { kind: 'clear' }
  | { kind: 'undo' }
  /** Escape with a tool selected goes back to the pointer instead of ending the show. */
  | { kind: 'release' };

/**
 * The presenting key map for annotations, shared by every surface so the keys
 * mean the same thing in the audience window, Speaker View and the browser.
 * P / L / T (or 1 / 2 / 3) pick the pen, laser dot and laser trail, E erases
 * the slide's ink, Cmd/Ctrl+Z takes back the last pen stroke.
 */
export function annotationKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  activeTool: AnnotationTool | null,
): AnnotationKeyAction | null {
  const command = event.metaKey || event.ctrlKey;
  if (command && !event.altKey && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    return { kind: 'undo' };
  }
  if (command || event.altKey) return null;
  switch (event.key) {
    case 'p':
    case 'P':
    case '1':
      return { kind: 'toggle', tool: 'pen' };
    case 'l':
    case 'L':
    case '2':
      return { kind: 'toggle', tool: 'laser' };
    case 't':
    case 'T':
    case '3':
      return { kind: 'toggle', tool: 'trail' };
    case 'e':
    case 'E':
      return { kind: 'clear' };
    case 'Escape':
      return activeTool ? { kind: 'release' } : null;
    default:
      return null;
  }
}

/** The key a surface uses for one slide's ink: its id, or its index before ids exist. */
export function annotationSlideKey(
  slides: readonly { id: string }[],
  index: number,
): string {
  return slides[index]?.id ?? `#${index}`;
}
