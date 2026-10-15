# Main-app browser acceptance

Real UI (Vite dev server with the repository's `vite.config.ts`, so workspace
packages resolve to their sources), the real browser driver / runtime / core,
and the real v1 HTTP and application layer (`createApp`, `assemblePlayback`,
SQLite stores, the real library DTO code). Only these parts are synthetic: the
provider (three generated WAVs, A/B/C at 16/20/24 s), the radio chooser, the
script writer, TTS, and the legacy non-playback dependencies (account, chat,
taste). **The DJ "voice" is a test tone, not speech. The account is a fake
login, not KuGou.**

```sh
node scripts/app-e2e/run.mjs                       # all scenarios
node scripts/app-e2e/run.mjs --scenario program,stage --out /tmp/some-dir
node scripts/app-e2e/fixture.mjs --web             # fixture only, for manual use (Ctrl-C stops it)
```

Environment (all optional):

| Variable | Meaning |
| --- | --- |
| `CLAUDIO_CHROME` | Chromium executable. Default: the newest `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`. |
| `CLAUDIO_CHROME_LIB_DIR` | Extra shared-library directory for that Chromium (`LD_LIBRARY_PATH`). |
| `CLAUDIO_E2E_FONT_DIR` | Directory with a CJK font (e.g. Noto Sans SC), added through a private fontconfig file. Without one, Chinese text may render as boxes. |

Isolation: each scenario starts its own fixture in a fresh `$TMPDIR/claudio-app-e2e-*`
directory (temporary cwd, data, profile, music and SQLite), with an allowlisted
environment. KuGou autostart is off, every real upstream points at
`127.0.0.1:9`, and no `.env` or credentials are inherited. API and Vite listen
on random ports on 127.0.0.1. The page may only reach those two origins; other
requests are aborted and recorded. Browser, Vite, server and SQLite are closed
when the scenario ends. The run directory is kept as evidence. Results go to
`--out` (default `$TMPDIR/claudio-app-e2e-results-*`): `summary.json`, plus
for each scenario `result.json`, screenshots, and page network/console logs.
The fixture's own `requests.jsonl`, `events.jsonl` and `final-state.json` stay
in its run directory.

Exit code is 0 only when every check of every selected scenario passed.

## What a check may rely on

- Snapshot identity and state, read through the dev-only bridges
  `window.__claudioPlayback` (`view`, `clock`, `log`, and `seek`, which is the
  same `controller.seek` the slider calls but with millisecond precision) and
  `window.__claudioStage` (stage state and diagnostics). Both bridges exist only
  in dev builds; the production bundle does not contain them.
- Native media elements (`paused`, `currentTime`, `src`), the AudioContext
  count, and sparse windows from the driver's existing analyser. These are
  pre-master PCM, not speaker output.
- The fixture server's request log (including which tab sent each request) and
  its real started store.
- Media Session: the observer records the handlers the app registered and
  calls them directly. This is not an OS media key.

User actions are real clicks, typing and key presses on the page. The one
exception is the 100 ms seek in the `stage` scenario, which goes through the
`seek` bridge.

## Scenarios

| Scenario | Covers |
| --- | --- |
| `program` | Chat 播放 A, then chat 下一首 B (queued ahead of a background radio pick). Caption shows the word-timed lyric. Pause freezes the native time. Seek while paused stays paused. Resume plays the same item with no second started. **Strict A→DJ→B**: the transition voice is speaking, the cue matches the snapshot transition from the A item to the chat-queued B item, the native voice element advances, the narration request is for that pair, and the script names B. Then B starts and the started store holds exactly B after A. Manual replay keeps the lyrics on the music. Panel pause stops only the voice while music keeps advancing. Two subtitle channels. No new started. Media Session play/pause are idempotent, Space toggles, one AudioContext. Refresh restores the queue stopped. |
| `ownership` | Two tabs. The observer has no AudioContext and no media, and sends no playback/now HTTP (server log and its own network). The owner is frozen for 5 s: the observer's snapshot stays the same and its position stops after the 1.5 s extrapolation bound. After the owner closes, the observer takes over without playing. |
| `controls` | Slow radio chooser (2.5 s). A Media Session pause during an empty-queue start queues the late candidate silently: no playing, no PCM, no started. Play then plays it. While a start will play, the main button reads 暂停 and pressing it does the same. |
| `features` | The old queue is imported through the server-stated `ref` of the real `/api/library` DTO, stopped, with the unknown song skipped, the old keys untouched and a backup kept. The like button is enabled and lights only after the server accepted. Chat plain reply and queuePick. Voice input (synthetic Web Speech and microphone; one final transcript, microphone released). Fake account login and logout. |
| `stage` | Pinned Folia export. Basic lyrics stay until the stage really draws (renderer ready, no status). The WebGL renderer string is recorded (SwiftShader software WebGL in headless Chromium). A screenshot of the Chinese current-line highlight is taken while media time is 4.4–5.2 s. The first timed line starts at 4.0 s, so earlier frames are dim by design. A paused 100 ms backward seek re-anchors both the owner's and the observer's stage via the core `seekEpoch`. |
| `rapid-next` | A double Next within one task: the skipped item never starts. 上一首 replays A as a new occurrence without bouncing back. |
| `source-failure` | B's source is unavailable: B never starts and is recorded as not played, and C plays. |
| `voice-failure` | TTS fails: no voice ever speaks, A ends as played, B starts. |
| `late-cue` | TTS is held past A's end, so B starts without voice. The cue released afterwards never speaks. |
| `new-source` | Provider bytes change, so a new occurrence gets a new source revision. Lyrics and started bind to the new revision, and the first occurrence keeps its own. |

## Not covered here

Real accounts, KuGou, model, Fish TTS and real speech. Hidden tabs over long
periods, lock screen and sleep. Physical speakers or OS media keys. Target
devices and daily (R5) use.
