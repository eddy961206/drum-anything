# 내 박자 밴드 · Follow My Rhythm Band

내가 두드린 리듬을 녹음하면 직접 작성한 규칙에 따라 베이스·코드·하이햇이 함께 연주하는 작은 음악 장난감입니다. AI 분석이나 자동 작곡은 사용하지 않습니다.

A tiny Korean-language music toy: tap **your own** rhythm, then hear a prepared original band play around it. No scoring, streaks, microphone, audio upload, AI/model calls, network API, account, tracking, or external assets.

## Run

No build or dependencies are required. Serve the `dist` folder over HTTP (JavaScript modules should not be opened through `file://`):

```sh
cd dist
python3 -m http.server 8080
# Open http://localhost:8080
```

## Play

1. **예시 밴드 듣기** starts a clearly labeled original example. The page is silent until a gesture unlocks Web Audio.
2. Choose **1마디 · 4박** or **2마디 · 8박**, then press **내 리듬 녹음**. Four audible beats count in. The large countdown then shows remaining recording beats.
3. Tap **쿵 / F** and **탁 / J** at any moment. Touch pads support independent multi-touch; key autorepeat is ignored.
4. The take ends automatically and loops the actual captured notes, with synthesized bass, chords, and hats. The bass follows kick onset positions; when a bar has no kick, it uses a prepared two-note fallback. Harmony and hats use explicitly authored rules, not musical analysis or AI.
5. Change **로파이 / 펑키 / 칠** for original voicings and articulation; mute/adjust accompaniment or master volume. Settings changes stop an active loop to prevent partially changed scheduling. Press play to restart with the new settings.
6. **겹쳐 녹음** adds notes to the current user take for its existing length, with count-in. **내 리듬 녹음** replaces only after at least one note is recorded. An empty or canceled take preserves the previous rhythm. **이전 테이크** restores the immediately preceding committed pattern when available.
7. **멈춤**, **Esc**, or the pause icon stops sound and keeps the rhythm. Play starts the loop from the beginning (this is not a resumable playhead pause).

A user's current take is retained in memory when auditioning the example; the demo button then becomes **내 리듬으로 돌아가기**. Refreshing or closing the page discards in-memory data. **리듬 저장** downloads local JSON with raw note timings and settings; it is not an audio export, cloud save, or import feature.

### Timing choices

- **그대로**: original fractional beat positions, including offbeats.
- **살짝 보정**: halfway toward the nearest sixteenth-note position.
- **16분음표로**: full sixteenth-note quantization.

Raw positions are never overwritten, so switching back to **그대로** is reversible. Timeline positions show the currently selected playback timing; tooltips and accessible timeline text give original recorded beat positions. Manual BPM is 50–180. Tempo tap uses the median of plausible intervals. Timing, length, mood, and metronome controls are frozen during count-in/recording. Changing next-recording length does not silently stretch or truncate an existing take.

## Architecture

- `dist/index.html`: semantic Korean responsive shell, native controls, labels and live statuses.
- `dist/style.css`: mint/blue physical-sequencer design, responsive layout, focus styles, reduced-motion support.
- `dist/rhythm.js`: pure rhythm/timing helpers and explicit count-in → recording → looping transport. Capture is capped at 128 notes per take. Empty takes never become fabricated user performances.
- `dist/audio.js`: original Web Audio oscillator/noise synthesis; master compressor, bounded volume/polyphony, lazy/concurrent unlock, source tracking and immediate scheduled-source cleanup.
- `dist/app.js`: UI orchestration, epoch-guarded async startup, one animation loop, keyboard/pointer handling, local JSON export.

The scheduler uses audio-context time and a short lookahead. Browser stalls skip stale events instead of bursting missed notes. Hidden tabs and page navigation stop/suspend playback; returning does not autoplay. Audio interruptions stop active transport. Recording cancellation never commits partial notes.

## Verification

```sh
npm test
npm run check
```

**35 automated tests pass**: 18 pure rhythm/transport tests, 9 mocked Web Audio tests, and 8 DOM/lifecycle harness tests. These cover exact offbeats, quantization reversibility, 1/2-bar count-in/end boundaries, empty/canceled takes, provenance, overdub/undo, cap, no duplicated events, scheduler stalls, deferred unlock cancellation, hidden-page cleanup, key repeat, input focus, demo/user roundtrip, and local-only static references. JavaScript syntax checks pass.

**Verification limit:** Real-browser rendering, mobile multitouch behavior on hardware, audible mix quality, and device latency remain unverified. Tests use deterministic mocks, not a browser or listening session.

## Privacy and originality

All sounds and example rhythms are original synthesis/code. No recordings or copyrighted songs are bundled. The app requests no microphone access and sends no app data over the network. JSON export contains musical notes/settings only. The page has no persistent storage. Browser/OS audio latency can vary; this is an expressive toy, not a precision recording workstation.
