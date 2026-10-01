import '../player/player.css';
import { annotationSlideKey } from '@shared/annotations.js';
import { parseDeck } from '@shared/deck.js';
import { AnnotationLayer } from '../player/annotationLayer.js';
import { AnnotationToolbar } from '../player/annotationToolbar.js';
import { bindPresentKeys } from '../player/keys.js';
import { Player } from '../player/player.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from '../player/links.js';

/**
 * Entry point for the exported standalone bundle.
 *
 * This is built separately as a self-contained IIFE so an exported deck is a
 * plain folder that opens in any browser with no app, no server and no build
 * step — which is also the safest way to present on a machine you don't control.
 *
 * The deck itself is injected as `window.__DECK__` by the generated index.html,
 * so the page needs no fetch and works straight off `file://`.
 */

declare global {
  interface Window {
    __DECK__?: unknown;
    /** Test/diagnostic handle for rendering an exact slide build state. */
    __SLIDE_PLAYER__?: Player;
  }
}

function boot(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root');
  if (!window.__DECK__) {
    root.textContent = 'No deck data found in this export.';
    return;
  }

  const deck = parseDeck(window.__DECK__);
  let annotations: AnnotationLayer | null = null;
  const player = new Player({
    deck,
    container: root,
    // Assets sit next to index.html, so their deck-relative paths already work.
    resolveSrc: (src) => src,
    onCursor: (cursor) => annotations?.setSlide(annotationSlideKey(deck.slides, cursor.slide)),
    onBlank: (blanked) => annotations?.setHidden(blanked),
  });
  window.__SLIDE_PLAYER__ = player;
  // The same pen and lasers as the app. One surface here, so nothing to mirror.
  let toolbar: AnnotationToolbar | null = null;
  annotations = new AnnotationLayer({
    host: root,
    canvas: deck.canvas,
    onToolChange: (tool) => toolbar?.reflect(tool),
  });
  annotations.setSlide(annotationSlideKey(deck.slides, player.getCursor().slide));
  toolbar = new AnnotationToolbar({ parent: document.body, layer: annotations });

  bindPresentKeys(window, player, {
    intercept: (event) => annotations?.handleKey(event) ?? false,
  });

  // Deep-linking for humans and agents alike: index.html#7 opens slide 7.
  // With this, "render slide N" is one headless-chromium screenshot away —
  // no app, no server.
  const jumpToHash = () => {
    const n = Number.parseInt(location.hash.replace('#', ''), 10);
    if (Number.isFinite(n) && n >= 1) player.goToSlide(n - 1);
  };
  window.addEventListener('hashchange', jumpToHash);
  jumpToHash();

  window.addEventListener('mousedown', (e) => {
    if (slideLinkFromEvent(e) || eventOnInteractiveWeb(e)) return;
    // The pen and the laser trail own the primary button while picked.
    if (e.button === 0 && annotations?.capturesPointer()) return;
    if (e.button === 0) player.next();
    else if (e.button === 2) player.prev();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
