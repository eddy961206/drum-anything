# 둥탁 · Doongtak

A browser-only, Korean-language two-finger drum playground. Serve `dist/` over HTTP to play. No dependencies, account, microphone, external media, analytics, paid APIs, or runtime network requests.

## Play

- Tap the orange **둥** and sage **탁** pads, or use **F / J** (also **D / K**). Pads can be previewed before a round. Simultaneous touch is supported; keyboard autorepeat is ignored.
- **같이 연주하기** starts 60 seconds of original Web Audio lofi keys, bass and light hats. The player supplies kick/snare. Space toggles transport when the page body has focus.
- **따라 치기** offers forgiving ±190 ms visual rhythm guidance. **마음대로** is free tapping, without matching or adaptation. No score, loss state or streaks.
- **너무 쉬워 / 조금 벅차** queue one pattern change at the next two-bar phrase. **딱 좋아** locks the present difficulty. Automatic adjustment requires two consecutive clear/struggling active phrases; silence never causes an adjustment. Tap spam cannot earn a harder pattern. Change the auto option in settings to re-enable it.
- Pause continues from the current time; restart resets the round and waits for another explicit start. Changing mode keeps the music going. The page pauses and suspends audio when hidden; returning never auto-plays.
- Settings include master volume, mute, automatic matching, and a -150…+350 ms hit-matching offset. Positive offset accommodates late taps, but cannot remove Bluetooth's physical sound delay. Wired headphones or device speakers are best.

## Implementation

Buildless ES modules: `dist/index.html`, `styles.css`, `app.js`, `rhythm.js`, `audio.js`. Backing is scheduled on the AudioContext clock with a 25 ms scheduler / 120 ms lookahead, not visual timer beats. Animation follows the audio clock. Delayed scheduler callbacks skip stale notes instead of bursting. Restart, pause, hidden tabs, interrupted audio and round completion clean up loops and scheduled voices. Volume is conservative and a compressor contains peaks.

Adaptive patterns change only at phrase boundaries. A lock prevents automatic changes. Exact timing feedback is deliberately gentle and not displayed as performance metrics. Preference state is session-only; no storage/tracking.

## Check

```sh
npm test
npm run check
python3 -m http.server 4173 --directory dist
```
