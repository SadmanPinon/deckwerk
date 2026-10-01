import type { AgentPanelState, RemoteAgentSetup, RemoteAgentStart } from '@shared/ipc.js';

/**
 * Collaborate → Remote agent: connect an agent running on another machine (a
 * lab server or cluster, over SSH) to the open deck, and watch it work.
 *
 * The form asks for the SSH host once; everything else has a default. Starting
 * hosts the deck as an agent session and produces one command for this Mac's
 * terminal (see src/main/remoteAgent.ts): it logs in, mirrors the deck into a
 * folder over there, keeps it in sync, and starts the agent in it. Every save
 * the agent makes lands in this editor a moment later, in History under the
 * agent's name.
 */

export interface RemoteAgentPanelApi {
  start: (setup: RemoteAgentSetup) => Promise<RemoteAgentStart>;
  openTerminal: () => Promise<void>;
  end: () => Promise<void>;
  sshHosts: () => Promise<string[]>;
  getState: () => Promise<AgentPanelState>;
  onState: (listener: (state: AgentPanelState) => void) => () => void;
  /** The started session, for the editor to join as a peer. */
  onStarted: (started: RemoteAgentStart) => void;
}

export interface RemoteAgentPanelOptions {
  api: RemoteAgentPanelApi;
  /** The open deck's folder name, for per-deck defaults. */
  deckName: () => string | null;
  /** Remembered values; injectable for tests. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

const STORE_PREFIX = 'deckwerk.remote-agent.';

export class RemoteAgentPanel {
  readonly element: HTMLElement;
  private readonly api: RemoteAgentPanelApi;
  private readonly options: RemoteAgentPanelOptions;
  private readonly status: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly host: HTMLInputElement;
  private readonly folder: HTMLInputElement;
  private readonly setup: HTMLInputElement;
  private readonly agent: HTMLInputElement;
  private readonly hostList: HTMLDataListElement;
  private readonly startButton: HTMLButtonElement;
  private readonly connect: HTMLElement;
  private readonly code: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly error: HTMLElement;
  private readonly shownMessages = new Set<string>();
  private started: RemoteAgentStart | null = null;
  private connected = false;

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
    this.status.className = 'agent-chat-status';
    this.status.textContent = 'Not connected';
    titleWrap.append(title, this.status);
    const actions = document.createElement('div');
    actions.className = 'agent-chat-header-actions';
    actions.append(quietButton('Hide', () => this.hide()));
    header.append(titleWrap, actions);

    this.form = document.createElement('form');
    this.form.className = 'remote-agent-form';
    this.hostList = document.createElement('datalist');
    this.hostList.id = 'remote-agent-hosts';
    this.host = field(this.form, 'SSH host', 'remote-agent-host', 'cluster or you@login.example.edu', true);
    this.host.setAttribute('list', this.hostList.id);
    this.host.autocomplete = 'off';
    this.folder = field(this.form, 'Folder on that machine', 'remote-agent-folder', '~/deckwerk/your-talk');
    this.setup = field(this.form, 'Run first (optional)', 'remote-agent-setup', 'module load nodejs');
    this.agent = field(this.form, 'Agent', 'remote-agent-agent', 'claude   (empty: only sync the folder)');
    this.form.append(this.hostList);
    this.startButton = document.createElement('button');
    this.startButton.type = 'submit';
    this.startButton.className = 'primary remote-agent-start';
    this.startButton.textContent = 'Start session';
    this.form.append(this.startButton);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.startSession();
    });

    this.connect = document.createElement('div');
    this.connect.className = 'agent-chat-connect remote-agent-connect';
    this.connect.hidden = true;
    const lead = document.createElement('p');
    lead.textContent = 'Run this in a terminal on this Mac:';
    const row = document.createElement('div');
    row.className = 'agent-chat-connect-row';
    this.code = document.createElement('code');
    const copy = quietButton('Copy', () => void navigator.clipboard.writeText(this.started?.command ?? '').then(
      () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); },
      () => { copy.textContent = 'Select and copy'; },
    ));
    copy.classList.add('agent-chat-connect-copy');
    row.append(this.code, copy);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary remote-agent-open';
    open.textContent = 'Open in Terminal';
    open.addEventListener('click', () => void this.api.openTerminal().catch((error) => this.showError(error)));
    const end = document.createElement('button');
    end.type = 'button';
    end.className = 'danger remote-agent-end';
    end.textContent = 'End session';
    end.addEventListener('click', () => void this.endSession());
    const buttons = document.createElement('div');
    buttons.className = 'remote-agent-buttons';
    buttons.append(open, end);
    this.hint = document.createElement('p');
    this.hint.className = 'remote-agent-hint';
    this.connect.append(lead, row, buttons, this.hint);

    this.messages = document.createElement('div');
    this.messages.className = 'agent-chat-messages';
    this.messages.setAttribute('aria-live', 'polite');
    const empty = document.createElement('div');
    empty.className = 'agent-chat-empty';
    empty.textContent = 'What the agent does to the deck appears here, and on the slides themselves.';
    this.messages.append(empty);

    this.error = document.createElement('div');
    this.error.className = 'agent-chat-error';
    this.error.hidden = true;

    panel.append(header, this.form, this.connect, this.error, this.messages);
    document.body.append(panel);
    this.element = panel;
    this.api.onState((state) => this.applyState(state));
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  show(): void {
    this.element.hidden = false;
    this.restore();
    void this.api.sshHosts().then((hosts) => {
      this.hostList.replaceChildren(...hosts.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        return option;
      }));
    }).catch(() => {});
    if (this.started) void this.api.getState().then((state) => this.applyState(state)).catch(() => {});
    else (this.host.value ? this.startButton : this.host).focus();
  }

  hide(): void {
    this.element.hidden = true;
  }

  toggle(): void {
    if (this.element.hidden) this.show();
    else this.hide();
  }

  /** The session ended elsewhere (End collaboration, the window, the app). */
  sessionEnded(): void {
    this.started = null;
    this.connected = false;
    this.connect.hidden = true;
    this.form.hidden = false;
    this.status.textContent = 'Not connected';
    delete this.status.dataset.state;
  }

  private async startSession(): Promise<void> {
    const setup: RemoteAgentSetup = {
      host: this.host.value.trim(),
      folder: this.folder.value.trim(),
      setup: this.setup.value.trim(),
      agent: this.agent.value.trim(),
    };
    this.remember(setup);
    this.error.hidden = true;
    this.startButton.disabled = true;
    this.status.textContent = 'Starting…';
    try {
      this.started = await this.api.start(setup);
      this.api.onStarted(this.started);
      this.form.hidden = true;
      this.connect.hidden = false;
      this.code.textContent = this.started.command;
      this.code.title = this.started.command;
      const agentNote = setup.agent
        ? `${setup.agent.split(/\s+/)[0]} starts there once the folder is in sync.`
        : 'Point your agent at that folder; only an agent on that same machine is seen.';
      this.hint.textContent = `Logs in to ${this.started.host} and keeps ${this.started.folder} in sync with this deck. ${agentNote}`;
      this.status.textContent = 'Waiting for the remote side…';
      this.status.dataset.state = 'idle';
    } catch (error) {
      this.status.textContent = 'Not connected';
      this.showError(error);
    } finally {
      this.startButton.disabled = false;
    }
  }

  private async endSession(): Promise<void> {
    try {
      await this.api.end();
    } catch (error) {
      this.showError(error);
    }
    this.sessionEnded();
  }

  private applyState(state: AgentPanelState): void {
    if (!this.started) return;
    this.connected = state.connection === 'ready';
    this.status.textContent = !this.connected
      ? 'Waiting for the remote side…'
      : state.busy ? state.activity ?? 'Working…' : `Connected · ${state.agentName ?? 'agent'}`;
    this.status.dataset.state = this.connected ? (state.busy ? 'busy' : 'ready') : 'idle';
    if (state.error) this.showError(state.error);
    for (const message of state.messages) {
      if (this.shownMessages.has(message.id)) continue;
      this.shownMessages.add(message.id);
      this.messages.querySelector('.agent-chat-empty')?.remove();
      const node = document.createElement('div');
      node.className = `agent-chat-message agent-chat-message-${message.role}`;
      node.dataset.messageId = message.id;
      const body = document.createElement('div');
      body.className = 'agent-chat-message-body';
      body.textContent = message.text;
      node.classList.toggle('error', message.error === true);
      node.append(body);
      this.messages.append(node);
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private restore(): void {
    const store = this.options.storage ?? localStorage;
    const deck = this.options.deckName() ?? 'deck';
    const read = (key: string) => {
      try {
        return store.getItem(STORE_PREFIX + key);
      } catch {
        return null;
      }
    };
    if (!this.host.value) this.host.value = read('host') ?? '';
    if (!this.setup.value) this.setup.value = read('setup') ?? '';
    if (!this.agent.value) this.agent.value = read('agent') ?? 'claude';
    this.folder.value = read(`folder:${deck}`) ?? '';
    this.folder.placeholder = `~/deckwerk/${deck.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  }

  private remember(setup: RemoteAgentSetup): void {
    const store = this.options.storage ?? localStorage;
    const deck = this.options.deckName() ?? 'deck';
    try {
      store.setItem(`${STORE_PREFIX}host`, setup.host);
      store.setItem(`${STORE_PREFIX}setup`, setup.setup ?? '');
      store.setItem(`${STORE_PREFIX}agent`, setup.agent ?? '');
      store.setItem(`${STORE_PREFIX}folder:${deck}`, setup.folder ?? '');
    } catch {
      // Remembering is a convenience; the session works without it.
    }
  }

  private showError(error: unknown): void {
    this.error.hidden = false;
    this.error.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
  }
}

function field(
  form: HTMLFormElement,
  label: string,
  id: string,
  placeholder: string,
  required = false,
): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.className = 'remote-agent-field';
  wrap.htmlFor = id;
  const caption = document.createElement('span');
  caption.textContent = label;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.required = required;
  wrap.append(caption, input);
  form.append(wrap);
  return input;
}

function quietButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-button ui-button-quiet';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}
