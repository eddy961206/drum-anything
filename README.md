# Drum Anything · 음악 놀이터

브라우저에서 가볍게 즐기는 음악 장난감 모음입니다. 완성한 앱의 코드, 테스트, 실행 방법을 모아 둡니다.

A collection of small browser-based music toys, with source, tests, and local run instructions.

## 앱 · Apps

| 앱 / App | 폴더 / Folder | 상태 / Status |
| --- | --- | --- |
| 둥탁 · Doongtak — 두 손가락 드럼 놀이터 / two-finger drum playground | [`apps/doongtak`](apps/doongtak) | 완료 / Ready |
| 후렴에 한 방 · Chorus Pocket Remixer — 노래 위에 필인과 효과 연주 / fills and effects over music | [`apps/remixer`](apps/remixer) | 기본 버전 완료 / Base version ready |
| 내 박자 밴드 · Follow My Rhythm Band — 내가 친 리듬에 반주 / a band around your own tapped rhythm | [`apps/follow-band`](apps/follow-band) | 완료 / Ready |
| 소리 수집소 · Everyday Sound Sampler — 생활 소리로 16칸 비트 / everyday sounds in a 16-step beat | [`apps/sampler`](apps/sampler) | 완료 / Ready |

완료는 소스 구현과 자동 테스트 기준입니다. 실제 브라우저·기기·청감 검증 범위는 앱별 README에 명시되어 있습니다. / Ready refers to source implementation and automated checks; see each README for real-browser, hardware, and listening verification limits.

## 실행 · Run

둥탁은 빌드나 설치가 필요 없는 정적 웹 앱입니다. Python 3으로 로컬 서버를 실행한 뒤 `http://localhost:4173`을 여세요. 소리는 화면의 시작 버튼을 누르면 재생됩니다.

Doongtak is a buildless static app. Serve it with Python 3, open `http://localhost:4173`, and start audio with an explicit tap or click.

```sh
python3 -m http.server 4173 --directory apps/doongtak/dist
```

다른 앱은 경로를 `apps/remixer/dist`, `apps/follow-band/dist`, `apps/sampler/dist`로 바꾸세요. / For another app, use its `apps/<name>/dist` folder instead.

**리믹서 범위 / Remixer scope:** YouTube는 공식 임베드 재생만 지원하며 음원 추출이나 AI 분리는 하지 않습니다. 미리 분리하고 정렬한 로컬 4개 스템(`drums`, `bass`, `other`, `vocals`, 각각 3분 이하)을 불러오면 드럼 음소거와 추정 타격 시점 안내를 사용할 수 있습니다. / YouTube support is official embedded playback only, not audio extraction or AI source separation. Four pre-separated, aligned local stems (each at most 3 minutes) enable drummer mode and estimated onset hints.

## 로컬 보조 앱 · Local companion

[`tools/stem-companion`](tools/stem-companion)는 정적 웹 앱과 별도로 **사용자 컴퓨터에서만 실행하는 Python 보조 앱**입니다. 외부 yt-dlp / FFmpeg / Demucs 설치 후, 이용 권한이 있는 공개 단일 YouTube URL 또는 로컬 파일의 전체 곡이나 선택 구간을 4개 스템으로 분리합니다. YouTube 미리보기에서 구간을 고르고, 전체 또는 지정 구간을 반복하며 여섯 드럼 패드를 연주할 수 있습니다.

The companion runs separately on your own computer, not inside a hosted frontend. It requires external tools for permitted public-URL acquisition or local-file processing and four-stem separation. Six CC0 drum recordings are bundled; model weights, executables, and user songs are not. Model downloads require an explicit choice. It does not provide cookies, account access, DRM/paywall/region bypass, or a workaround for blocked acquisition.

**상태 / Status:** 이전 구현에서 Windows의 실제 YouTube 영상 30초 분리를 확인했습니다. 전체 곡 처리의 실제 모델 검증과 청감 확인은 진행 중입니다. / A previous version separated 30 seconds of a real YouTube video on Windows; real-model verification of the full-song path and listening quality remain in progress. See the companion README for setup, rights, model-license limitations, and cleanup.

## 확인 · Check

Node.js 20 이상과 npm이 필요합니다. 런타임 의존성이나 설치 단계는 없습니다.

Requires Node.js 20+ and npm. No dependency installation is needed.

```sh
npm test
npm run check
```

위 명령은 브라우저 앱을 검사합니다. 로컬 보조 앱은 별도로 검사하세요. / The commands above check browser apps. Check the companion separately:

```sh
cd tools/stem-companion
python3 -m unittest discover -s tests -v
node --test tests/test_ui.cjs
python3 -m py_compile companion.py
node --check static/app.js
```

앱별 조작 방법과 구현 설명은 각 폴더의 README를 참고하세요. / See each app's README for controls and implementation notes.

## 개인정보와 오디오 · Privacy & audio

- 둥탁은 Web Audio로 직접 소리를 합성하며 음원 파일, 계정, 마이크, 분석 도구를 사용하지 않습니다.
- 사용자 업로드 음원, 비밀키, 환경 파일, 개인 배포 설정은 이 저장소에 포함하지 않습니다.
- Doongtak synthesizes original audio with Web Audio: no audio samples, account, microphone, analytics, or runtime network requests.
- User media, credentials, environment files, and private deployment configuration are not included.
- 리믹서의 로컬 파일은 브라우저 메모리에서만 처리됩니다. YouTube 연결은 사용자가 영상 불러오기를 눌렀을 때만 시작됩니다. / Remixer local media stays in browser memory; the optional YouTube connection starts only after the user loads a video.
- 소리 수집소는 녹음 버튼을 눌렀을 때만 마이크 권한을 요청하고 최대 3초 녹음합니다. 소리와 비트는 탭 메모리에만 있어 새로고침/닫기 시 사라집니다. WAV 저장은 선택한 소리 하나를 기기에 내려받으며 업로드하지 않습니다. / The sampler requests microphone permission only after an explicit recording action, records for at most 3 seconds, and keeps sounds/patterns in tab memory only. Refreshing or closing loses the work; WAV export downloads one selected sound locally without uploading it.
