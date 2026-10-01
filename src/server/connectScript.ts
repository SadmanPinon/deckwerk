/**
 * The script behind a remote-agent session's one-line handshake
 * (`curl -fsSL '<link>/connect.sh?token=…&agent=…' | bash`).
 *
 * Pasted into a terminal on the agent's machine, a lab server or a cluster's
 * login node, it mirrors the deck into a folder there (the deck's name in the
 * current directory, or the folder given as its argument), keeps it in sync
 * in the background, and returns the prompt so the person can start their
 * agent in that folder. The bridge stops by itself when the host disconnects,
 * quits, or its link has been gone for twenty seconds.
 *
 * Everything here runs on a machine DeckWerk does not control, so it asks for
 * no more than bash, curl and Node, and says plainly what is missing. The
 * session token reaches the bridge through the environment, which keeps it
 * out of the process list there.
 */

export interface ConnectScriptInput {
  /** The session's public origin, as the agent's machine reaches it. */
  origin: string;
  deckId: string;
  participantId: string;
  token: string;
}

/** One POSIX shell word holding `value` exactly. */
export function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A folder name for the deck on the remote side. */
export function remoteDeckFolderName(deckId: string): string {
  const name = deckId.split('/').filter(Boolean).at(-1) ?? 'deck';
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'deck';
}

export function connectScript(input: ConnectScriptInput): string {
  const session = `${input.origin}/?deck=${encodeURIComponent(input.deckId)}`
    + `&agent=${encodeURIComponent(input.participantId)}`;
  return `#!/usr/bin/env bash
# DeckWerk: connect a folder on this machine to a deck open on your computer.
set -u
ORIGIN=${shellWord(input.origin)}
SESSION=${shellWord(session)}
DECK=${shellWord(remoteDeckFolderName(input.deckId))}
export DECKWERK_SESSION_TOKEN=${shellWord(input.token)}
TARGET="\${1:-$PWD/$DECK}"
case "$TARGET" in /*) ;; *) TARGET="$PWD/$TARGET" ;; esac
say() { printf '\\033[1mDeckWerk:\\033[0m %s\\n' "$*"; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 20 ]; then
  # Clusters keep Node in their module system.
  module load nodejs >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  say "Node.js is needed on $(hostname) (22 or newer). Try: module load nodejs   or   nvm install 22"
  exit 1
fi
NODE_FLAGS=""
MAJOR="$(node_major)"
if [ "$MAJOR" -lt 20 ]; then
  say "Node $(node -v) on $(hostname) is too old; 22 or newer is needed (nvm install 22)."
  exit 1
elif [ "$MAJOR" -lt 22 ]; then
  NODE_FLAGS="--experimental-websocket"
fi

mkdir -p "$HOME/.deckwerk"
BRIDGE="$HOME/.deckwerk/deckwerk-connect.mjs"
if ! curl -fsSL -H "x-deckwerk-token: $DECKWERK_SESSION_TOKEN" "$ORIGIN/deckwerk-connect.mjs" -o "$BRIDGE.part"; then
  say "could not reach DeckWerk. Is it still connected on your computer?"
  exit 1
fi
mv "$BRIDGE.part" "$BRIDGE"

PIDFILE="$HOME/.deckwerk/bridge-$DECK.pid"
if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; fi
LOG="$HOME/.deckwerk/bridge-$DECK.log"
nohup node $NODE_FLAGS "$BRIDGE" "$SESSION" --dir "$TARGET" --name "Agent on $(hostname -s 2>/dev/null || hostname)" --until-disconnected >"$LOG" 2>&1 </dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
for _ in $(seq 1 300); do
  if grep -q "Deck mirrored at" "$LOG" 2>/dev/null; then
    say "connected. $TARGET is live with DeckWerk."
    say "next:  cd \\"$TARGET\\" && claude"
    say "Disconnect in DeckWerk (or quitting it) ends this; the folder stays."
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    say "could not connect:"
    tail -n 5 "$LOG"
    exit 1
  fi
  sleep 0.1
done
say "still connecting; see $LOG"
`;
}
