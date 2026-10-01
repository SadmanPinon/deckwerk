// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPanelState, RemoteAgentLink } from '../src/shared/ipc.js';
import { openCollaborateChooser } from '../src/renderer/editor/collaborateChooser.js';
import {
  RemoteAgentPanel,
  type RemoteAgentLight,
  type RemoteAgentPanelApi,
} from '../src/renderer/editor/remoteAgentPanel.js';

/** Collaborate's chooser, and the Remote agent panel driven through a fake main process. */

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
  let api: RemoteAgentPanelApi;
  let lights: RemoteAgentLight[];

  const LINE = "curl -fsSL 'https://brave-otter.trycloudflare.com/connect.sh?token=t&agent=p' | bash";
  const link: RemoteAgentLink = {
    connection: { active: true, deckId: 'Fall26', wsUrl: 'ws://127.0.0.1:5800/ws?deck=Fall26&token=t', name: 'me', mode: 'agent' },
    line: LINE,
    url: 'https://brave-otter.trycloudflare.com',
  };
  const state = (over: Partial<AgentPanelState> = {}): AgentPanelState => ({
    deckPath: '/decks/Fall26', connection: 'unavailable', agentName: null, scratchpad: null,
    busy: false, activity: null, messages: [], error: null, ...over,
  });

  beforeEach(() => {
    document.body.replaceChildren();
    stateListener = null;
    lights = [];
    api = {
      connect: vi.fn(async () => link),
      disconnect: vi.fn(async () => {}),
      getState: vi.fn(async () => state()),
      onState: (listener) => {
        stateListener = listener;
        return () => {};
      },
      onConnected: vi.fn(),
      copy: vi.fn(async () => {}),
    };
  });

  const open = () => {
    const panel = new RemoteAgentPanel({ api, deckName: () => 'Fall26', onLight: (light) => lights.push(light) });
    panel.show();
    return panel;
  };
  const light = (panel: RemoteAgentPanel) => panel.element.querySelector<HTMLElement>('.remote-agent-light')!;

  it('starts off, with nothing but a Connect button', () => {
    const panel = open();
    expect(light(panel).dataset.light).toBe('off');
    expect(panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.hidden).toBe(false);
    expect(panel.element.querySelector<HTMLElement>('.remote-agent-handshake')!.hidden).toBe(true);
    expect(panel.element.querySelector('input')).toBeNull();
  });

  it('Connect shows the one line to paste, and copies it', async () => {
    const panel = open();
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.click();
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('waiting'));
    expect(lights).toEqual(['off', 'opening', 'waiting']);
    expect(api.onConnected).toHaveBeenCalledWith(link);
    expect(panel.element.querySelector('code')!.textContent).toBe(LINE);
    expect(panel.element.querySelector('.remote-agent-hint')!.textContent).toContain('./Fall26');
    panel.element.querySelector<HTMLButtonElement>('.agent-chat-connect-copy')!.click();
    expect(api.copy).toHaveBeenCalledWith(LINE);
  });

  it('turns green when the server side connects, and logs what it does', async () => {
    const panel = open();
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.click();
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('waiting'));
    stateListener!(state({
      connection: 'ready',
      agentName: 'Agent on vulcan',
      messages: [{ id: 'm1', role: 'system', text: 'live at /home/pinon/adajepa/slides/Fall26 on vulcan' }],
    }));
    expect(light(panel).dataset.light).toBe('connected');
    expect(light(panel).textContent).toBe('Connected · Agent on vulcan');
    expect(panel.element.querySelector<HTMLElement>('.remote-agent-handshake')!.hidden).toBe(true);
    expect(panel.element.querySelector('.agent-chat-message-body')!.textContent)
      .toContain('/home/pinon/adajepa/slides/Fall26');
  });

  it('Disconnect closes it and goes back to off', async () => {
    const panel = open();
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.click();
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('waiting'));
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-disconnect')!.click();
    await vi.waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('off'));
    expect(panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.hidden).toBe(false);
  });

  it('says why when the link cannot open', async () => {
    api.connect = vi.fn(async () => {
      throw new Error("Error invoking remote method 'remoteAgent:connect': Error: Install it once with: brew install cloudflared");
    });
    const panel = open();
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.click();
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('error'));
    expect(panel.element.querySelector('.agent-chat-error')!.textContent)
      .toBe('Install it once with: brew install cloudflared');
  });

  it('goes back to off when the session ends elsewhere', async () => {
    const panel = open();
    panel.element.querySelector<HTMLButtonElement>('.remote-agent-connect-button')!.click();
    await vi.waitFor(() => expect(light(panel).dataset.light).toBe('waiting'));
    panel.sessionEnded();
    expect(light(panel).dataset.light).toBe('off');
  });
});
