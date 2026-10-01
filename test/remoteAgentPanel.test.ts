// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPanelState, RemoteAgentSetup, RemoteAgentStart } from '../src/shared/ipc.js';
import { openCollaborateChooser } from '../src/renderer/editor/collaborateChooser.js';
import { RemoteAgentPanel, type RemoteAgentPanelApi } from '../src/renderer/editor/remoteAgentPanel.js';

/** Collaborate's chooser, and the Remote agent panel driven through a fake main process. */

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe('collaborate chooser', () => {
  beforeEach(() => document.body.replaceChildren());

  it('offers people or a remote agent, and runs the one picked', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const invite = vi.fn();
    const remoteAgent = vi.fn();
    openCollaborateChooser(anchor, { invite, remoteAgent });
    const choices = [...document.querySelectorAll<HTMLButtonElement>('#collaborate-chooser .collaborate-choice')];
    expect(choices.map((choice) => choice.querySelector('strong')!.textContent))
      .toEqual(['Invite people', 'Remote agent']);
    choices[1].click();
    expect(remoteAgent).toHaveBeenCalledOnce();
    expect(invite).not.toHaveBeenCalled();
    expect(document.querySelector('#collaborate-chooser')).toBeNull();
  });

  it('closes on Escape without choosing', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const invite = vi.fn();
    openCollaborateChooser(anchor, { invite, remoteAgent: vi.fn() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('#collaborate-chooser')).toBeNull();
    expect(invite).not.toHaveBeenCalled();
  });
});

describe('remote agent panel', () => {
  let stateListener: ((state: AgentPanelState) => void) | null;
  let api: RemoteAgentPanelApi & { started: RemoteAgentSetup[] };
  let storage: ReturnType<typeof memoryStorage>;

  const started = (setup: RemoteAgentSetup): RemoteAgentStart => ({
    connection: { active: true, deckId: 'talk', wsUrl: 'ws://127.0.0.1:5800/ws?deck=talk&token=t', name: 'me', mode: 'agent' },
    command: `ssh -t -R 41234:127.0.0.1:5800 '${setup.host}' 'bash -lc …'`,
    folder: setup.folder || '~/deckwerk/talk',
    host: setup.host,
  });

  const state = (over: Partial<AgentPanelState> = {}): AgentPanelState => ({
    deckPath: '/decks/talk', connection: 'unavailable', agentName: null, scratchpad: null,
    busy: false, activity: null, messages: [], error: null, ...over,
  });

  beforeEach(() => {
    document.body.replaceChildren();
    stateListener = null;
    storage = memoryStorage();
    api = {
      started: [],
      start: vi.fn(async (setup: RemoteAgentSetup) => {
        api.started.push(setup);
        return started(setup);
      }),
      openTerminal: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      sshHosts: vi.fn(async () => ['cluster', 'lab-gpu']),
      getState: vi.fn(async () => state()),
      onState: (listener) => {
        stateListener = listener;
        return () => {};
      },
      onStarted: vi.fn(),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  const open = () => {
    const panel = new RemoteAgentPanel({ api, deckName: () => 'talk', storage });
    panel.show();
    return panel;
  };

  it('asks for the host, then shows the one command and opens it in Terminal', async () => {
    const panel = open();
    const host = panel.element.querySelector<HTMLInputElement>('#remote-agent-host')!;
    expect(host.required).toBe(true);
    expect(panel.element.querySelector<HTMLInputElement>('#remote-agent-agent')!.value).toBe('claude');
    host.value = 'cluster';
    panel.element.querySelector<HTMLInputElement>('#remote-agent-folder')!.value = '~/project_A/slides';
    panel.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.started[0]).toEqual({ host: 'cluster', folder: '~/project_A/slides', setup: '', agent: 'claude' });
    await vi.waitFor(() => expect(panel.element.querySelector('.remote-agent-connect')!.hasAttribute('hidden'))
      .toBe(false));
    expect(panel.element.querySelector('code')!.textContent).toContain("'cluster'");
    expect(panel.element.querySelector('.remote-agent-hint')!.textContent).toContain('~/project_A/slides');
    expect(api.onStarted).toHaveBeenCalledOnce();

    panel.element.querySelector<HTMLButtonElement>('.remote-agent-open')!.click();
    expect(api.openTerminal).toHaveBeenCalledOnce();
  });

  it('shows the agent connecting and what it does to the deck', async () => {
    const panel = open();
    panel.element.querySelector<HTMLInputElement>('#remote-agent-host')!.value = 'cluster';
    panel.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    await vi.waitFor(() => expect(panel.element.querySelector('.agent-chat-status')!.textContent)
      .toContain('Waiting'));
    stateListener!(state({
      connection: 'ready',
      agentName: 'Agent on cluster',
      messages: [{ id: 'm1', role: 'system', text: 'synced edit/work.html: replaced 1 slide' }],
    }));
    expect(panel.element.querySelector('.agent-chat-status')!.textContent).toBe('Connected · Agent on cluster');
    expect(panel.element.querySelector('.agent-chat-message-body')!.textContent)
      .toBe('synced edit/work.html: replaced 1 slide');
  });

  it('remembers the host, and the folder per deck', async () => {
    const first = open();
    first.element.querySelector<HTMLInputElement>('#remote-agent-host')!.value = 'cluster';
    first.element.querySelector<HTMLInputElement>('#remote-agent-folder')!.value = '~/project_A/slides';
    first.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    first.element.remove();
    const second = open();
    expect(second.element.querySelector<HTMLInputElement>('#remote-agent-host')!.value).toBe('cluster');
    expect(second.element.querySelector<HTMLInputElement>('#remote-agent-folder')!.value).toBe('~/project_A/slides');
  });

  it('ends the session and goes back to the form', async () => {
    const panel = open();
    panel.element.querySelector<HTMLInputElement>('#remote-agent-host')!.value = 'cluster';
    panel.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(panel.element.querySelector('.remote-agent-connect')!.hasAttribute('hidden'))
      .toBe(false));
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-end')!.click();
    await vi.waitFor(() => expect(api.end).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(panel.element.querySelector('form')!.hasAttribute('hidden')).toBe(false));
  });

  it('reports a failure to start where the person is looking', async () => {
    api.start = vi.fn(async () => {
      throw new Error("Error invoking remote method 'remoteAgent:start': Error: Enter the SSH host you log in to");
    });
    const panel = open();
    panel.element.querySelector<HTMLInputElement>('#remote-agent-host')!.value = 'x y';
    panel.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(panel.element.querySelector('.agent-chat-error')!.textContent)
      .toBe('Enter the SSH host you log in to'));
  });
});
