import '../../src/renderer/player/player.css';
import '../../src/renderer/player/type.css';
import '../../src/renderer/appChrome.css';
import '../../src/renderer/presenter/presenter.css';
import { annotationSlideKey, type AnnotationCommand } from '../../src/shared/annotations.js';
import { parseDeck } from '../../src/shared/deck.js';
import type { PresentationCommand } from '../../src/shared/ipc.js';
import { AnnotationLayer } from '../../src/renderer/player/annotationLayer.js';
import { AnnotationToolbar } from '../../src/renderer/player/annotationToolbar.js';
import { bindPresentKeys } from '../../src/renderer/player/keys.js';
import { Player } from '../../src/renderer/player/player.js';
import { createSpeakerView, type SpeakerView } from '../../src/renderer/presenter/speakerView.js';

/**
 * The audience surface and Speaker View in one page, so pen and laser input can
 * be tried on either and watched arriving on the other. The fake transport
 * defers each command a task, as IPC would.
 */
const params = new URLSearchParams(location.search);
const deckName = params.get('deck') ?? 'decks/deckwerk_intro';
const deck = parseDeck(await (await fetch(`/${deckName}/deck.json`)).json());
const themeCss = await (await fetch(`/${deckName}/theme.css`)).text();
const theme = document.createElement('style');
theme.textContent = themeCss;
document.head.appendChild(theme);
const resolveSrc = (src: string) => `/${deckName}/${src.replace(/^\/+/, '')}`;

const audienceHost = document.getElementById('audience')!;
const startedAt = Date.now();
let speaker: SpeakerView | null = null;
let audience: AnnotationLayer | null = null;
const log: Array<{ from: string; command: AnnotationCommand }> = [];
const relay = (from: string, deliver: (command: AnnotationCommand) => void) =>
  (command: AnnotationCommand) => {
    log.push({ from, command });
    setTimeout(() => deliver(command), 0);
  };

const player = new Player({
  deck,
  container: audienceHost,
  resolveSrc,
  onCursor: (cursor, steps) => {
    audience?.setSlide(annotationSlideKey(deck.slides, cursor.slide));
    speaker?.setState({ cursor, steps, startedAt, slideStartedAt: Date.now() });
  },
  onBlank: (blanked) => audience?.setHidden(blanked),
});
let toolbar: AnnotationToolbar | null = null;
audience = new AnnotationLayer({
  host: audienceHost,
  canvas: deck.canvas,
  onCommand: relay('audience', (command) => speaker?.annotate(command)),
  onToolChange: (tool) => toolbar?.reflect(tool),
});
toolbar = new AnnotationToolbar({ parent: audienceHost, layer: audience });

const run = (command: PresentationCommand) => {
  if (command.type === 'next') player.next();
  else if (command.type === 'prev') player.prev();
  else if (command.type === 'toggleBlank') player.toggleBlank();
};
speaker = createSpeakerView({
  host: document.getElementById('speaker')!,
  resolveSrc,
  onCommand: run,
  canSwapDisplays: false,
  onAnnotation: relay('speaker', (command) => audience?.apply(command)),
});
speaker.setTheme(themeCss);
speaker.setDeck(deck);
player.goToSlide(Number(params.get('slide') ?? 0));

bindPresentKeys(window, player, { intercept: (event) => audience?.handleKey(event) ?? false });
audienceHost.addEventListener('click', () => {
  if (!audience?.capturesPointer()) player.next();
});

Object.assign(window, { player, audience, speaker, toolbar, annotationLog: log });
