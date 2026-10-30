# 후렴에 한 방 — Chorus Pocket Remixer

브라우저 음악 장난감: 직접 합성한 데모, 로컬 음원, 공식 YouTube 플레이어, 또는 미리 분리한 로컬 4개 스템 위에 패드를 연주합니다. YouTube 음원 추출이나 AI 분리는 하지 않으며, 스템은 같은 시작점으로 정렬된 3분 이하 파일이 필요합니다.

A buildless Korean music playground. No score, practice plan, or account is required by the app code. Choose an original synthesized demo, a local audio file, an official YouTube player, or four already-separated local stems, then play pads over the music.

## Run and check

Serve `dist/` with an ordinary static web server (ES modules need HTTP/HTTPS):

```sh
python3 -m http.server 8080 --directory dist
# Open http://localhost:8080 in a modern browser.
node --check dist/app.js
npm run check
npm test
```

No install step or package dependencies. The app is static HTML/CSS/ES modules. It uses the browser's Web Audio API and Canvas.

## Playing

- **Demo / local file:** Press ▶ to start the original 104 BPM demo, or select a supported audio file. Files stay in browser memory and are not uploaded or stored.
- **Pads:** `F` short two-beat fill ending with a crash; `J` crash; `D` kick; `K` hold muffle and release to restore. `S` is an extra snare. `Space` toggles playback and `T` taps tempo, unless a text input or native button is focused.
- **Timing:** Next-beat mode schedules against the Web Audio clock. Immediate mode follows your fingers. BPM is manual: it does **not** detect the song's beat phase or change song speed. Tapping while playing sets tempo and aligns the current beat.
- **Mix:** Overall volume and pad volume are separate. In YouTube mode, overall volume also controls the official player.
- **Advanced:** Local audio supports A/B looping. Muffle affects the local song/stems, not pad sounds.

## YouTube mode

Paste a single-video YouTube URL and explicitly press “영상 불러오기”. Only then does the app load the official IFrame Player API. The official player stays visible, with its controls; the video is cued, never automatically played. Press its play control.

This mode adds independent synthesized pads. It does **not** download, capture, separate, filter, or analyze YouTube audio. It offers no extracted note guidance, drum removal, muffle, or A/B looping. Manual beat alignment is approximate and iframe/device latency can be audible. Private, deleted, embed-disabled, blocked, or unavailable videos may not play. Errors are reported without bypassing restrictions.

Official API documentation: https://developers.google.com/youtube/iframe_api_reference

## “내가 드러머” — already-separated stems

Select `drums`, `bass`, `other`, and `vocals` files from the same aligned export. All four start together on one AudioContext timeline, and seek/loop/pause together.

- **모두 듣기:** all stems.
- **보컬만:** vocals only.
- **악기만:** drums + bass + other (no vocals).
- **내가 드러머:** bass + other + vocals, original drums muted.

Mode changes ramp gains without restarting or shifting sources. Default after import is drummer mode.

This app does **not** perform AI source separation. It requires files already separated with a separate local tool. Import requires all four files, at most 180 seconds each, duration difference no more than 0.25 seconds, at most 50 MiB per file / 100 MiB combined, and at most 256 MiB decoded audio. Memory-heavy encodings can be rejected even below compressed-file limits. Use matching short excerpts on memory-limited devices. Matching length cannot prove alignment: export all stems from the same start point.

### Optional follow-along hints

The app examines the local **drum stem** with an energy-rise onset detector. It shows estimated sound-start dots against the shared song timeline. It does not classify kick/snare, transcribe a score, generate fake beat notes from BPM, or assess performance. Missed/extra attacks are possible. Silence may yield no cues. Guided mode selects immediate pad timing; free mode hides the cues. Guidance is unavailable for YouTube and ordinary mixed song files.

## Privacy and sound provenance

- No microphone permission, recording, media upload, analytics, telemetry, external audio samples, API keys, or persistent media storage.
- All demo music and pad sounds are synthesized in `audio.js`; no copyrighted recordings are bundled.
- Local-file/stem mode has no application network requests beyond loading the site's own static files.
- YouTube is the only optional third-party runtime connection, initiated by the user's explicit link-load action. That player is subject to YouTube's own network/cookie behavior.
- The original song's drums remain present for ordinary files and YouTube. Only already-separated stem playback can mute its drum stem.

## Lifecycle and verification

One local transport owns playback. New loads are generation-guarded and commit atomically; failed imports retain the previous paused song. Pause, seek, source changes, hidden tabs, and page exit cancel queued voices. Hold release/cancel, keyboard release, and window blur restore the filter. Hidden tabs never auto-resume. Stem sources share an AudioContext start with a short scheduling lead; mix changes do not alter phase.

**50 automated tests pass** (Node built-in test runner): DOM event integration, no autoplay, touch/keyboard deduplication, asynchronous unlock/load cancellation, held-effect cleanup, file errors, A/B looping, tap tempo, external YouTube timing, strict URL parsing and player lifecycle, four-source synchronization and mix matrices, loading/memory/alignment limits, and deterministic onset detection. All five JavaScript modules pass syntax checks.

**Verification limit:** These automated tests use mocks and do not verify live YouTube availability, device audio latency, or listening quality. A user-gesture playback/listening check on an actual device is still needed. The app does not bypass authentication or player restrictions.

## Files

- `dist/index.html`, `dist/style.css`: responsive accessible interface.
- `dist/app.js`: source switching, controls, local file UI, guide rendering.
- `dist/audio.js`: synthesized sounds, single/stem transport, timing, gain routing.
- `dist/timing.js`: pure BPM and phase helpers.
- `dist/youtube.js`: official lazy player adapter and strict URL parser.
- `dist/onsets.js`: local drum-stem onset estimates.
- `tests/`: dependency-free deterministic tests.
