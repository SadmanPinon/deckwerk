import type { AgentPanelState, RemoteAgentLink } from '@shared/ipc.js';

/**
 * Collaborate → Remote agent: let an agent on a server or cluster (Claude Code
 * in a terminal there) edit the open deck live.
 *
 * Nothing is reachable until Connect. Connect hosts the deck as a token-locked
 * session behind a temporary public link and shows one line to paste in a
 * terminal on that machine; the light turns green once it has connected.
 * Disconnect, closing the window or quitting DeckWerk takes the link down.
 */

export interface RemoteAgentPanelApi {
  connect: () => Promise<RemoteAgentLink>;
  disconnect: () => Promise<void>;
  getState: () => Promise<AgentPanelState>;
  onState: (listener: (state: AgentPanelState) => void) => () => void;
  /** The session that Connect started, for the editor to join as a peer. */
  onConnected: (link: RemoteAgentLink) => void;
  copy?: (text: string) => Promise<void>;
}

export interface RemoteAgentPanelOptions {
  api: RemoteAgentPanelApi;
  /** The open deck's folder name: the folder the agent's side creates. */
  deckName: () => string | null;
  /** Light changes, for a matching mark on the toolbar button. */
  onLight?: (light: RemoteAgentLight) => void;
}

export type RemoteAgentLight = 'off' | 'opening' | 'waiting' | 'connected' | 'error';

export class RemoteAgentPanel {
  readonly element: HTMLElement;
  private readonly api: RemoteAgentPanelApi;
  private readonly options: RemoteAgentPanelOptions;
  private readonly status: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly handshake: HTMLElement;
  private readonly code: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly disconnectButton: HTMLButtonElement;
  private readonly messages: HTMLElement;
  private readonly error: HTMLElement;
  private readonly shownMessages = new Set<string>();
  private link: RemoteAgentLink | null = null;
  private light: RemoteAgentLight = 'off';

  constructor(options: RemoteAgentPanelOptions) {
    this.options = options;
    this.api = options.api;

    const panel = document.createElement('aside');
    panel.id = 'remote-agent-panel';
    panel.className = 'agent-chat-panel remote-agent-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'remote-agent-title');

    const header = document.createElement('header');
    header.className = 'agent-chat-header';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'remote-agent-title';
    title.textContent = 'Remote agent';
    this.status = document.createElement('span');
    this.status.className = 'agent-chat-status remote-agent-light';
    titleWrap.append(title, this.status);
    const actions = document.createElement('div');
    actions.className = 'agent-chat-header-actions';
    actions.append(quietButton('Hide', () => this.hide()));
    header.append(titleWrap, actions);

    this.intro = document.createElement('div');
    this.intro.className = 'remote-agent-intro';
    const explain = document.createElement('p');
    explain.textContent = 'Let Claude Code on your server or cluster edit this deck live. '
      + 'Nothing is reachable until you connect; Disconnect, or quitting DeckWerk, closes it.';
    this.connectButton = document.createElement('button');
    this.connectButton.type = 'button';
    this.connectButton.className = 'primary remote-agent-connect-button';
    this.connectButton.textContent = 'Connect';
    this.connectButton.addEventListener('click', () => void this.connect());
    this.intro.append(explain, this.connectButton);

    this.handshake = document.createElement('div');
    this.handshake.className = 'agent-chat-connect remote-agent-handshake';
    this.handshake.hidden = true;
    const lead = document.createElement('p');
    lead.textContent = 'In a terminal on your server, go to the folder for the deck, then paste:';
    const row = document.createElement('div');
    row.className = 'agent-chat-connect-row';
    this.code = document.createElement('code');
    const copy = quietButton('Copy', () => void this.copyLine(copy));
    copy.classList.add('agent-chat-connect-copy');
    row.append(this.code, copy);
    this.hint = document.createElement('p');
    this.hint.className = 'remote-agent-hint';
    this.handshake.append(lead, row, this.hint);

    this.disconnectButton = document.createElement('button');
    this.disconnectButton.type = 'button';
    this.disconnectButton.className = 'danger remote-agent-disconnect';
    this.disconnectButton.textContent = 'Disconnect';
    this.disconnectButton.hidden = true;
    this.disconnectButton.addEventListener('click', () => void this.disconnect());

    this.error = document.createElement('div');
    this.error.className = 'agent-chat-error';
    this.error.hidden = true;

    this.messages = document.createElement('div');
    this.messages.className = 'agent-chat-messages remote-agent-messages';
    this.messages.setAttribute('aria-live', 'polite');
    this.messages.hidden = true;

    panel.append(header, this.intro, this.handshake, this.disconnectButton, this.error, this.messages);
    document.body.append(panel);
    this.element = panel;
    this.setLight('off');
    this.api.onState((state) => this.applyState(state));
  }

  getLight(): RemoteAgentLight {
    return this.light;
  }

  show(): void {
    this.element.hidden = false;
    if (this.link) void this.api.getState().then((state) => this.applyState(state)).catch(() => {});
    else this.connectButton.focus();
  }

  hide(): void {
    this.element.hidden = true;
  }

  toggle(): void {
    if (this.element.hidden) this.show();
    else this.hide();
  }

  /** The session ended elsewhere: the window, the app, or the link dying. */
  sessionEnded(): void {
    this.link = null;
    this.handshake.hidden = true;
    this.disconnectButton.hidden = true;
    this.intro.hidden = false;
    this.connectButton.disabled = false;
    this.setLight('off');
  }

  private async connect(): Promise<void> {
    this.error.hidden = true;
    this.connectButton.disabled = true;
    this.setLight('opening');
    try {
      this.link = await this.api.connect();
      this.api.onConnected(this.link);
      this.intro.hidden = true;
      this.handshake.hidden = false;
      this.disconnectButton.hidden = false;
      this.code.textContent = this.link.line;
      this.code.title = this.link.line;
      const folder = (this.options.deckName() ?? 'deck').replace(/[^A-Za-z0-9._-]+/g, '-');
      this.hint.textContent = `It creates ./${folder} there (or updates it) and keeps it live; `
        + 'then run claude in that folder. To use another folder, add its path at the end.';
      this.setLight('waiting');
    } catch (error) {
      this.connectButton.disabled = false;
      this.setLight('error');
      this.showError(error);
    }
  }

  private async disconnect(): Promise<void> {
    this.disconnectButton.disabled = true;
    try {
      await this.api.disconnect();
    } catch (error) {
      this.showError(error);
    } finally {
      this.disconnectButton.disabled = false;
    }
    this.sessionEnded();
  }

  private async copyLine(button: HTMLButtonElement): Promise<void> {
    const line = this.link?.line ?? '';
    try {
      await (this.api.copy ?? ((text: string) => navigator.clipboard.writeText(text)))(line);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch {
      button.textContent = 'Select and copy';
    }
  }

  private applyState(state: AgentPanelState): void {
    if (!this.link) return;
    const connected = state.connection === 'ready';
    this.setLight(connected ? 'connected' : 'waiting', connected
      ? (state.busy ? state.activity ?? 'Working…' : `Connected · ${state.agentName ?? 'agent'}`)
      : undefined);
    // Once the agent's side is live, the line has done its job.
    this.handshake.hidden = connected;
    if (state.error) this.showError(state.error);
    for (const message of state.messages) {
      if (this.shownMessages.has(message.id)) continue;
      this.shownMessages.add(message.id);
      const node = document.createElement('div');
      node.className = `agent-chat-message agent-chat-message-${message.role}`;
      node.classList.toggle('error', message.error === true);
      const body = document.createElement('div');
      body.className = 'agent-chat-message-body';
      body.textContent = message.text;
      node.append(body);
      this.messages.append(node);
      this.messages.hidden = false;
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private setLight(light: RemoteAgentLight, text?: string): void {
    this.light = light;
    this.status.dataset.light = light;
    this.status.textContent = text ?? {
      off: 'Off',
      opening: 'Opening a secure link…',
      waiting: 'Waiting for your server…',
      connected: 'Connected',
      error: 'Could not connect',
    }[light];
    this.options.onLight?.(light);
  }

  private showError(error: unknown): void {
    this.error.hidden = false;
    this.error.textContent = error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      : String(error);
  }
}

function quietButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-button ui-button-quiet';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}
