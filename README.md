# Wombo

Turn Slippi replays into shareable Melee clips.

Point it at your replay folder, watch a game, mark a start and an end, and get a
real `.mp4` out. It will also read every replay you own and tell you which
moments are worth posting — kills, zero-to-deaths, spikes, long punishes —
ranked and filterable.

To get a clip into Discord, press **Copy for Discord** and paste it into any
channel with Ctrl+V. Discord uploads it itself, so there is no account and
nothing to configure. (Hosted links are parked — see *Sharing* below.)

## Get it

Download the latest release, unzip it anywhere, and run **`Wombo.exe`**.
There is no installer and nothing is written outside your user folder.

You also need:

- **Slippi Launcher**, with the playback build present (watch one replay
  through it once) and your Melee ISO configured. Wombo reads both from
  Slippi's own settings.
- **ffmpeg** on your PATH — this is what actually encodes the video:

  ```
  winget install Gyan.FFmpeg
  ```

  Wombo tells you in the window if it cannot find it.

## Running from source

```bash
npm install
npm run shell     # the single-window app
npm start         # or just the server, then open http://localhost:5730
npm run package   # build dist/Wombo-win32-x64/
```

## How it works

There is no headless Melee renderer, so the only honest way to get video out of
a `.slp` is to make Slippi's playback Dolphin play it while dumping frames.
Wombo does exactly that, in a sandbox:

1. **Detect** — `src/detect.mjs` runs slippi-js stats over the replay and scores
   every *conversion* (one player's uninterrupted punish). Kills, damage, hit
   count, opening type and the victim's death direction feed the score, so a
   0-to-death ranks above a stray up-throw upair. Clip boundaries come from the
   first hit minus ~1.7s of neutral, out to the KO plus ~2.7s.
2. **Render** — `src/render.mjs` writes a playback queue, launches the sandboxed
   Dolphin with frame + audio dumping on, and waits. Dolphin does not exit when
   a queue drains even with `-b`, so completion is detected by watching
   `dspdump.wav`, which grows at exactly 128000 bytes per second of captured
   gameplay. ffmpeg then squares the non-square dump up to 4:3 and encodes
   h264/aac.
3. **Share** — `src/share.mjs` uploads to catbox.moe and hands back a direct
   `.mp4` URL, which is what makes the clip play inline in Discord rather than
   becoming a link people have to click.

Roughly **25 seconds of wall clock per clip**, most of it Melee booting. Renders
are strictly serial — only one Dolphin may run at a time.

Renders are **silent**. Beware Dolphin's naming here: `DumpAudioSilent` and
`DumpFramesSilent` suppress the "overwrite the existing dump?" dialog and have
nothing to do with sound. Actual silence comes from `[DSP] Volume = 0`, which is
safe because Dolphin's audio dump is taken *before* the volume stage — a muted
capture is byte-for-byte identical to a full-volume one (verified by md5).
Slippi's Jukebox has its own audio output that DSP volume never reaches, so it
is muted separately; it never reaches the dump either, so that costs nothing.
Preview playback stays audible.

## One window (`shell/`)

Dolphin has no plugin or overlay API, so a clip list drawn *inside* its render
would mean forking Slippi's Dolphin in C++ — weeks, plus a re-merge on every
Slippi update. (The Slippi Launcher is an Electron app driving Dolphin for
exactly this reason.)

The cheaper answer is to take Dolphin's window rather than draw inside it.
Wombo runs as an Electron window, leaves a hole in the page for the player, and
parks Dolphin over it.

**Do not use `SetParent`.** Making Dolphin a child of the Electron window works
perfectly at the Win32 level — it parents, positions correctly, and reports
`visible: true` — and you still see nothing but black. Chromium renders through
DirectComposition straight into the top-level window, and that surface
composites *over* native child windows. Enumerating the Electron window's
children confirms why there is no way around it: Chromium has no child HWND of
its own to sit behind, so there is no z-order to win. You get audio and an empty
panel.

Instead Wombo is made the window's **owner** (`GWLP_HWNDPARENT`), not its
parent. Dolphin stays top-level, so it keeps its own render surface and actually
draws, while Windows guarantees an owned window sits above its owner and
minimises and restores with it. `WS_EX_TOOLWINDOW` keeps it out of the taskbar
and alt-tab so it reads as part of the app.

Three details that matter:

- **Strip the chrome.** Otherwise it draws its own title bar and border inside
  your panel. Style becomes `WS_POPUP | WS_VISIBLE`, no caption.
- **Coordinates stay in screen space**, so placement is content origin + the
  panel's offset in the page, times the display scale factor.
- **An owned window does not follow its owner.** Dragging the app has to
  reposition it, not just resizing — and it has to be hidden on minimise or it
  floats over whatever you switch to.

Note that `Get-Process ... MainWindowHandle` returns 0 once the window is a tool
window, so discovery has to happen *before* docking (or via `EnumWindows`).

Native calls go through `koffi` rather than PowerShell because a resize has to
keep up with a dragged window edge, and a process spawn per frame cannot.
Window *discovery* still uses PowerShell — it happens once per boot.

The app also **adopts any Dolphin it finds**, not just ones it started. The app
and a browser tab share the same server, so a clip played from a stray tab would
otherwise open a Dolphin the app never claims — which looks exactly like the
embedding being broken. A 2-second watcher removes that whole class of
confusion, and re-adopts after the player is stopped and restarted.

`WOMBO_SELFTEST=1 npm run shell` drives the whole path with no human: it walks
the replay list until one yields clips, **clicks the ▶ Dolphin button in the
page**, and reports whether the window got adopted. It deliberately goes through
the renderer — an earlier version called the attach directly from the main
process, which proved the native adoption worked while saying nothing about
whether anything ever asks for it.

Two runtimes, one caveat: slippi-js ships both an ESM and a CommonJS build behind
the same path, and Node 24 resolves the ESM one while the Node inside Electron
resolves the CommonJS one. `createRequire` is used to always get CommonJS, so the
same source runs under both.

## The live player (the fast path)

Rendering something just to look at it is backwards. Dolphin is the only thing
that can play a `.slp` at all, and booting Melee is the only expensive part of
it — so **▶ Dolphin** boots one Dolphin and keeps it. Every clip after that
plays in well under a second.

```
first clip   boots Dolphin   ~10s
second clip  623 ms          no reboot
third clip   772 ms          no reboot
```

The mechanism is the playback comm file, and it took two experiments to find:

- **Replacing the queue does nothing.** Slippi tracks a *position* in the queue,
  so a rewritten one-entry queue looks like one it already finished. Dolphin
  ignores it and sits idle.
- **Appending works.** An entry added after the current position is picked up
  and played with no restart.

Which decides the design: play exactly one clip at a time and let Dolphin go
idle after it. An idle Dolphin starts an appended clip immediately, so every
click is instant. Queue several at once and the later ones wait their turn.

Dolphin's own window can also be positioned from outside (`GetWindowRect` /
`MoveWindow` via user32), so the player can be docked beside the clip list
rather than landing wherever Windows feels like. `POST /api/player/dock`.

### Gameplay only, and no visible scrubbing

Docked into the app, Dolphin shows the game and nothing else — its toolbar,
status bar and seek bar are turned off in `Dolphin.ini`, and the app supplies the
transport controls instead.

Melee is deterministic, so Dolphin cannot jump to a frame; it works its way there
and you watch it scrub. There is no setting to suppress that, so the panel is
covered until the seek finishes. **The signal is FPS in Dolphin's window title**,
which is the only telemetry it exposes — `outputOverlayFiles` writes nothing in
this build. Emulation *speed* looks like the obvious choice and is useless: it
sits at 100% throughout, because the seek runs on its own thread rather than by
running the emulator faster. FPS is unambiguous:

```
[60/60/100%]                            playing
[20/59/99%] [0/59/99%] [0/59/99%]       seeking (~2.4s for 8000 -> 300)
[60/60/100%]                            the clip starts
```

### Why the transport controls work the way they do

**Dolphin's hotkeys cannot be driven programmatically.** `PostMessage` of
`WM_KEYDOWN` is ignored, and so is `SendKeys` with the window focused — its input
device is DirectInput, which ignores injected input. So there is no way to script
pause or frame-advance.

The controls are therefore built on the queue instead, which is entirely ours:
replay, previous/next clip and nudging the start are all just appends, and each
one re-seeks under the cover. Dolphin's own keyboard controls (seek bar, Jump
Forwards/Backwards, Frame Advance) still work — press **Focus** first to give it
the keyboard.

A render and the player both want the one Dolphin, so `/api/player/play`
refuses while a render is in flight, and starting a render kills the player.

## Previewing before you commit

Video can only come out of Dolphin — there is no headless Melee renderer — so
"preview without Dolphin" is impossible for real footage. What is possible is
making Dolphin cheap and rare. Two ways, on every clip row:

**Preview** renders a *draft*: 360p, native internal resolution, crf 30. About
**800KB against 8MB** for the same clip, and it plays inline in the page. Drafts
are cached by clip identity (replay + in + out), so looking again is ~100ms and
costs nothing. They live in `%APPDATA%\Wombo\drafts`, not your Videos folder,
and the newest 60 are kept.

**Preview selected** drafts everything you ticked in **one Dolphin launch**.
Booting Melee costs ~9s and playing a clip costs a fraction of that, so five
previews one at a time is mostly five boots. The queue plays them back to back
into one continuous dump which is then cut apart. The cut is not frame-perfect —
Dolphin drops a few frames at the start of a capture, so the dump runs about
0.05s short over 11s, spread proportionally across the cuts. That is invisible
when the question is "is this worth rendering properly".

**Diagram** skips rendering entirely: it draws the clip from the replay's own
position data on a canvas — stage, players, percent, stocks, a motion trail,
with a camera that follows the action. Instant, ~17KB, no emulator at all. It
will not tell you whether a combo looked good, but it will tell you whether you
picked the right moment and framed it correctly, which is what the in/out
handles are for.

Renders also run with **uncapped emulation** (`EmulationSpeed = 0`). Frame
dumping records every emulated frame however fast they are produced, so this cut
a 14.8s clip from 23.2s to 14.2s of wall time with a byte-identical result.

## Auto Clips

Suggestions come in two places. Under the player, you get what the detector
found in the replay you have open — click one and it marks that range, ready to
nudge, preview or render like anything you marked by hand.

The **Auto Clips** tab ranks every moment across every replay at once, so you can
ask "what were the best three clips from Sunday" rather than opening 54 games.
Filter by day, month or year; by whose clip it is (yours or your opponent's); by
what happened (0-to-death, spike, hard read, long combo…); by either character;
by player; or by minimum damage. Sort by any column, and clicking a row plays it
in the same player with the same controls.

The date filter is the one that goes back to the server rather than narrowing
what is already loaded: the pool is the top few thousand clips overall, so a
quiet day's moments would never have made the global cut. Picking a date
re-ranks within it.

Analysing one replay costs ~240ms, so the first all-time pass over a few hundred
replays takes a couple of minutes. Two things make that bearable:

- **It is cached to disk** (`clipcache.json`, keyed by the same size+mtime stamp
  as the header index). A later run over the same 458 replays takes ~2 seconds,
  and survives restarts. The cache stores *unranked* clips, so changing your
  connect code re-sorts instead of re-parsing.
- **The scan yields between replays.** Parsing is synchronous and would pin the
  event loop for the whole scan, meaning the server could never answer the
  progress polls the page is making. Yielding caps the worst-case response at
  one replay's parse time.

Changing "top 25/50/100" slices the ranked list that is already in memory — it
never re-scans. Selecting different days does start a new scan, and abandons the
one in flight rather than queueing behind it.

Clips here carry their own replay path, so a selection spanning several games
renders correctly.

## Doubles

slippi-js computes **no stats at all** for anything but 1v1 —
`getSinglesPlayerPermutationsFromSettings` returns `[]` unless
`players.length === 2`, so every stat computer downstream sees nothing and a
4-player game comes back with zero conversions and zero stocks.

So doubles goes through `statsFromFrames()`, which rebuilds conversions and
stocks straight from the frame data (`percent`, `lastHitBy`, `actionStateId`)
and hands them to the *same* scorer, so singles behaviour is untouched. Two
things that are easy to get wrong there:

- **A kill is not near its killing blow.** The gap between the last hit and the
  blast zone is the victim's flight time — measured 51 to 243 frames. The window
  has to be generous; the attacker match is what keeps it honest.
- **`stocksRemaining` ticks down too late.** Melee decrements it when the KO
  animation *finishes*, by which point the player is respawning and the action
  state no longer names the blast zone. Detect entry into a `Dead*` state
  (0–10) instead — that is the actual moment of the KO.

Friendly fire is ignored, and the UI labels these games "doubles (frame
analysis)" so you know which path produced the list.

## Your Slippi install is not touched

On first run the playback build (~35MB) is robocopied to
`%APPDATA%\Wombo\playback` and every config change lands there. The real
install, your replays, and your netplay settings are read-only to Wombo. This
is the same sandboxing Peppy uses.

## Sharing

**Hosted links are disabled for now** — the buttons are there but greyed out.

The upload code works, but every anonymous host tested was either unreliable or
too short-lived to promise anyone. catbox returned perfectly good URLs for files
it stored as zero bytes; 0x0.st has disabled uploads over bot spam; tmpfiles and
qu.ax serve `text/html`, so Discord will not embed them; uguu works but deletes
after a few hours. Uploads are now verified before a link is recorded, so a
silent failure can no longer be saved as a dead link.

Until a host worth trusting is wired in, **Copy for Discord** does the job: it
puts the `.mp4` on your clipboard and Discord does the upload when you paste.
Works in servers and DMs, no account, nothing to configure.

Renders always stay local first (`%USERPROFILE%\Videos\Wombo`). Nothing leaves
your machine unless you press a button that says it will.

## Files

| | |
|---|---|
| `serve.mjs` | local server + render queue; the UI talks only to this |
| `src/dolphin.mjs` | sandbox, ini editing, playback queue, process launch |
| `src/detect.mjs` | highlight scoring — the part worth tuning |
| `src/render.mjs` | capture-completion watching + ffmpeg encode |
| `src/player.mjs` | the live Dolphin player — queue append, window control |
| `src/motion.mjs` | position tracks for the no-render Diagram view |
| `src/share.mjs` | upload adapters (catbox, litterbox, uguu) + upload verification |
| `src/discord.mjs` | posting a clip to a Discord webhook (built, currently unused) |
| `src/library.mjs` | replay index, cross-replay best-of scan, clip records, config |
| `web/` | the UI |

## Tuning what counts as a highlight

Everything lives in `src/detect.mjs`. The two knobs you will actually want:

- `PRE_ROLL` / `POST_ROLL_KILL` — how much neutral leads in, how long the camera
  lingers after the KO.
- the `score < 45` cutoff in `grade()` — lower it to see more marginal punishes,
  raise it to only get the obvious stuff.

## Requirements

- Windows. The single-window app uses Win32 calls to park Dolphin in the page.
- Slippi Launcher, with the playback build present (watch one replay through it
  once) and your Melee ISO configured. Wombo reads both from Slippi's own
  settings — it ships no game files and cannot help you obtain any.
- `ffmpeg` on PATH.
- Node 20+ (uses `fs.openAsBlob`).

## Known limits

- Rendering opens a Dolphin window. It is not stealable focus for long, but it
  is not invisible either.
- Doubles scoring was tuned on 1v1, and doubles clips have no `openingType`, so
  the neutral-win bonus never applies to them.
- The first scan of a large replay folder parses every file; after that it is
  cached against size+mtime in `%APPDATA%\Wombo\index.json`.
