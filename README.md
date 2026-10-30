# Drum Anything · 음악 놀이터

브라우저에서 가볍게 즐기는 음악 장난감 모음입니다. 완성한 앱의 코드, 테스트, 실행 방법을 모아 둡니다.

A collection of small browser-based music toys, with source, tests, and local run instructions.

## 앱 · Apps

| 앱 / App | 폴더 / Folder | 상태 / Status |
| --- | --- | --- |
| 둥탁 · Doongtak — 두 손가락 드럼 놀이터 / two-finger drum playground | [`apps/doongtak`](apps/doongtak) | 완료 / Ready |
| 후렴에 한 방 · Chorus Pocket Remixer — 노래 위에 필인과 효과 연주 / fills and effects over music | [`apps/remixer`](apps/remixer) | 기본 버전 완료 / Base version ready |

## 실행 · Run

둥탁은 빌드나 설치가 필요 없는 정적 웹 앱입니다. Python 3으로 로컬 서버를 실행한 뒤 `http://localhost:4173`을 여세요. 소리는 화면의 시작 버튼을 누르면 재생됩니다.

Doongtak is a buildless static app. Serve it with Python 3, open `http://localhost:4173`, and start audio with an explicit tap or click.

```sh
python3 -m http.server 4173 --directory apps/doongtak/dist
```

리믹서를 실행하려면 경로를 `apps/remixer/dist`로 바꾸세요. / For the remixer, use `apps/remixer/dist` instead.

**리믹서 범위 / Remixer scope:** YouTube는 공식 임베드 재생만 지원하며 음원 추출이나 AI 분리는 하지 않습니다. 미리 분리하고 정렬한 로컬 4개 스템(`drums`, `bass`, `other`, `vocals`, 각각 3분 이하)을 불러오면 드럼 음소거와 추정 타격 시점 안내를 사용할 수 있습니다. / YouTube support is official embedded playback only, not audio extraction or AI source separation. Four pre-separated, aligned local stems (each at most 3 minutes) enable drummer mode and estimated onset hints.

## 확인 · Check

Node.js 20 이상과 npm이 필요합니다. 런타임 의존성이나 설치 단계는 없습니다.

Requires Node.js 20+ and npm. No dependency installation is needed.

```sh
npm test
npm run check
```

앱별 조작 방법과 구현 설명은 각 폴더의 README를 참고하세요. / See each app's README for controls and implementation notes.

## 개인정보와 오디오 · Privacy & audio

- 둥탁은 Web Audio로 직접 소리를 합성하며 음원 파일, 계정, 마이크, 분석 도구를 사용하지 않습니다.
- 사용자 업로드 음원, 비밀키, 환경 파일, 개인 배포 설정은 이 저장소에 포함하지 않습니다.
- Doongtak synthesizes original audio with Web Audio: no audio samples, account, microphone, analytics, or runtime network requests.
- User media, credentials, environment files, and private deployment configuration are not included.
- 리믹서의 로컬 파일은 브라우저 메모리에서만 처리됩니다. YouTube 연결은 사용자가 영상 불러오기를 눌렀을 때만 시작됩니다. / Remixer local media stays in browser memory; the optional YouTube connection starts only after the user loads a video.
