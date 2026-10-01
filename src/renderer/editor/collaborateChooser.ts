/**
 * Collaborate's two kinds of session, offered from the toolbar button: people
 * on the network in their browsers, or an agent on another machine.
 */

export interface CollaborateChoices {
  invite: () => void;
  remoteAgent: () => void;
}

let open: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeCollaborateChooser(): void {
  cleanup?.();
  cleanup = null;
  open?.remove();
  open = null;
}

export function openCollaborateChooser(anchor: HTMLButtonElement, choices: CollaborateChoices): void {
  if (open) {
    closeCollaborateChooser();
    return;
  }
  const menu = document.createElement('div');
  menu.id = 'collaborate-chooser';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Collaborate');
  const option = (title: string, detail: string, action: () => void, className: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `collaborate-choice ${className}`;
    button.setAttribute('role', 'menuitem');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const note = document.createElement('span');
    note.textContent = detail;
    button.append(heading, note);
    button.addEventListener('click', () => {
      closeCollaborateChooser();
      action();
    });
    return button;
  };
  menu.append(
    option('Invite people', 'A link anyone on this network opens in a browser to edit with you.',
      choices.invite, 'collaborate-choice-invite'),
    option('Remote agent', 'An agent on your server or cluster edits this deck live, over SSH.',
      choices.remoteAgent, 'collaborate-choice-agent'),
  );
  document.body.append(menu);
  open = menu;

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - 8))}px`;
  menu.style.top = `${anchorRect.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onPointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) closeCollaborateChooser();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCollaborateChooser();
      anchor.focus();
    }
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  cleanup = () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'false');
  };
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}
