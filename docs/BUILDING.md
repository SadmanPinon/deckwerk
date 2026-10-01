# Building DeckWerk from source

Every platform DeckWerk supports can be built from this repository with the
same three commands. This is the path to use if you are on a distribution the
released packages do not cover, on an architecture we do not yet publish, or
you simply want to run your own build.

```bash
git clone https://github.com/vsitzmann/deckwerk.git
cd deckwerk
npm ci
npm run dist
```

The installer lands in `release/`: a `.dmg` on macOS, an `.exe` on Windows, and
an `.AppImage`, `.deb` and `.tar.gz` on Linux.

## You build for your own machine, not for other people's

`npm run dist` produces packages for **the platform and architecture you run
it on**. There is no cross-build, and this is not a missing feature:

- `ffmpeg-static` downloads, and `@ffprobe-installer/ffprobe` installs, a
  binary for the host during `npm ci`, and the app ships whatever they fetched.
- The Keynote and PowerPoint importers are PyInstaller freezes, and
  PyInstaller cannot cross-compile — not even between macOS architectures.

If you need packages for several platforms, that is what the release workflow
is for; see [RELEASING.md](RELEASING.md).

## Prerequisites

| | Version |
| --- | --- |
| Node.js | 22 or newer |
| Python | 3.10 or newer |
| git | any |

Releases are built with Node 22 and Python 3.12; newer versions of both work.
Nothing else has to be installed by hand — `npm ci` fetches Electron, and
`npm run dist` fetches the packaging tools it needs.

Python is required to **build**, and is not required to **run**. The Keynote
and PowerPoint importers are each frozen by PyInstaller into a single binary
with the interpreter and every dependency inside it, shipped alongside the app.
Someone who installs DeckWerk from a `.dmg`, an `.exe`, or Flathub imports
`.key` and `.pptx` files on a machine with no Python at all.

```bash
brew install python                          # macOS
sudo apt-get install python3 python3-venv    # Debian/Ubuntu
winget install Python.Python.3.12            # Windows
```

If Python is missing, `npm run dist` stops immediately with those instructions
rather than failing somewhere inside the packaging step.

### Linux

Building needs no extra packages, but *running* an Electron app does. On
Debian and Ubuntu:

```bash
sudo apt-get install -y libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
  xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0
```

Installing the `.deb` this build produces pulls those in for you; the
`.AppImage` does not, so install them first if you plan to use it.

## Running without packaging

To use or hack on DeckWerk without producing an installer:

```bash
npm ci
npm run dev
```

That starts the app with hot reload. `npm test` runs the suite; see
[AGENTS.md](../AGENTS.md) for architecture and testing notes.

## Signing

Local builds are unsigned, which is fine for your own machine but means macOS
Gatekeeper will refuse an unsigned `.dmg` copied to *another* Mac. The signing
configuration switches itself on only when credentials are present, so nothing
needs changing to build unsigned — see [RELEASING.md](RELEASING.md) if you want
to sign your own builds.
