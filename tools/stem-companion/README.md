# 로컬 자동 음원분리 · Music Stem Companion

**유튜브 영상 URL 또는 내 음악 파일 → 선택 구간 → 4개 스템 자동 분리 → 드럼을 끄고 내가 연주.**

이 폴더는 실행 가능한 **로컬 보조 앱 소스**입니다. 공개 웹 앱에서 유튜브 오디오를 추출하거나 사용자의 컴퓨터에 프로그램을 자동 설치하지 않습니다. 브라우저 UI와 Python 서버를 **같은 `http://127.0.0.1:8765` 주소**에서 엽니다. 공개 웹사이트와 localhost 사이의 연결/권한 우회는 없습니다.

## 할 수 있는 것

- 음악 파일 가져오기, 또는 일반 **공개 단일 YouTube 영상 URL**을 내부 `yt-dlp` 명령으로 취득.
- 최대 15분 / 100 MiB 원본에서 1–180초를 선택하고 FFmpeg로 PCM WAV 변환.
- 외부 설치 Demucs `htdemucs`로 vocals / bass / drums / other 4개 정렬 스템 생성.
- 완료 시 4개 스템을 자동으로 브라우저에 로드. 재생은 직접 버튼을 누릅니다.
- 전체 / 보컬 / 반주 / 드러머 모드, 개별 볼륨, 탐색, 구간 반복.
- 분리된 드럼의 실제 파형 에너지 변화로 **추정 타격 시점** 표시; D/F 또는 화면 패드로 킥/스네어 자유 연주. 정확한 악보/드럼 종류 판별은 아닙니다.
- 실제 단계 표시, 취소(자식 프로세스 포함 종료), 로컬 파일 삭제. 가짜 진행률은 없습니다.

## 먼저 알아둘 점

이 소스는 사용자가 이용 권한을 확인한 콘텐츠용입니다. **공개 영상이나 개인용이라는 이유만으로 다운로드·분리 권한이 생기지는 않습니다.** 권리 및 [YouTube 이용약관](https://www.youtube.com/static?template=terms)을 별도로 확인하세요. 체크박스는 허가를 부여하지 않습니다. 지역/연령/로그인/결제/DRM/봇 검사로 막히면 작업이 실패하며, 쿠키·계정·새 프록시 설정·CAPTCHA 풀이·접근제한 우회는 제공하지 않습니다. 관리 환경의 기존 승인된 네트워크 경로를 유지하는 명시적 옵션은 아래를 확인하세요. 사설/미등록/라이브/재생목록도 받지 않습니다.

**모델과 음악의 권리는 코드 라이선스와 별개입니다.** Demucs 코드의 MIT 라이선스를 사전학습 가중치 라이선스로 간주하지 마세요. 현재 유지관리 저장소는 가중치의 라이선스가 명확하지 않다고 설명합니다. 모델을 제공받을 권한/조건을 확인한 후 사용하세요.

## 설치 — 사용자가 직접 선택해서 실행

권장: Python **3.11 또는 3.12**, 가상환경, 최신 FFmpeg/FFprobe, YouTube용 Deno. Python 표준 라이브러리만으로 서버와 테스트는 실행됩니다. 분리 도구는 따로 필요합니다. 운영체제/CPU/GPU에 따라 PyTorch 설치가 달라질 수 있으므로 공식 설치 안내를 확인하세요.

### Windows PowerShell

Python과 [FFmpeg/FFprobe](https://ffmpeg.org/download.html), [Deno](https://docs.deno.com/runtime/getting_started/installation/)를 신뢰할 수 있는 배포처에서 설치하고 새 터미널의 PATH에서 실행 가능한지 확인합니다. 이 안내는 시스템 보안 설정이나 PowerShell 실행 정책 변경을 요구하지 않습니다.

```powershell
cd tools/stem-companion
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install "yt-dlp[default]"
.\.venv\Scripts\python.exe -m pip install "demucs==4.1.0" numpy
ffmpeg -version
ffprobe -version
deno --version
.\.venv\Scripts\python.exe companion.py --check
```

Demucs는 공식 PyPI의 고정 버전으로 설치합니다. 4.1.0은 Linux에서도 NumPy를 사용하지만 패키지 의존성 선언에서 빠져 있어 `numpy`를 명시합니다. 이 명령은 사용자가 실행할 때만 외부 패키지를 내려받습니다. 플랫폼 호환성은 아래 검증 범위를 확인하세요.

### Linux / macOS

Python 3.11/3.12, 가상환경 기능, FFmpeg/FFprobe, Deno를 운영체제에 맞는 신뢰할 수 있는 패키지 관리자로 설치한 뒤:

```bash
cd tools/stem-companion
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install 'yt-dlp[default]'
.venv/bin/python -m pip install 'demucs==4.1.0' numpy
ffmpeg -version
ffprobe -version
deno --version
.venv/bin/python companion.py --check
```

Deno/yt-dlp/ejs가 없어도 로컬 파일 경로의 필요 도구가 있으면 파일 분리는 가능합니다. YouTube 경로는 세 도구를 모두 확인합니다. `--check`는 Demucs·Torch·NumPy 등 패키지 메타데이터와 실행파일 존재를 확인할 뿐 모델/음악을 내려받거나 추론하지 않습니다. **존재 확인은 바이너리 호환성 및 추론 성공 검증이 아닙니다.**

### 실행: 모델 정책을 하나 선택

**A. 이미 보유한 신뢰할 수 있는 로컬 모델 저장소** (`htdemucs.yaml` 및 그 YAML이 참조하는 모든 `.th` 가중치; Demucs `--repo` 형식):

```bash
.venv/bin/python companion.py --model-repo /absolute/path/to/demucs-models
```

**B. 모델 조건을 확인했으며 첫 작업 시 외부 가중치 다운로드를 허용하는 경우:**

```bash
.venv/bin/python companion.py --allow-model-download
```

로컬 모델 모드는 고정된 `htdemucs` 이름과 명시적인 `--repo`를 사용하여 Demucs의 로컬 로더를 선택하고, `HF_HUB_OFFLINE=1` 및 `TRANSFORMERS_OFFLINE=1`을 설정합니다. 모델 라이브러리의 다운로드 제한이며 사용자가 제출한 YouTube 취득을 막는 전역 네트워크 차단은 아닙니다. **YAML과 가중치는 신뢰할 수 있는 출처만 사용하세요.** 로컬 `.th` 체크포인트의 역직렬화는 안전하지 않은 파일에서 코드를 실행할 수 있습니다. 필요한 파일이 없거나 형식이 맞지 않으면 작업은 실패하고 원격 모델로 대체하지 않습니다. [Demucs 로컬 모델 로더](https://github.com/adefossez/demucs/blob/v4.1.0/demucs/repo.py)

Windows는 위 `.venv/bin/python` 대신 `.\.venv\Scripts\python.exe`를 사용하세요. `--allow-model-download`는 이 프로세스를 위한 **명시적 선택**입니다. 없으면 기본적으로 모델 다운로드를 시작하지 않고 의존성 부족을 표시합니다. **이 리포지터리에 가중치나 바이너리는 들어 있지 않습니다.**

브라우저에서 **http://127.0.0.1:8765** 를 열고 소스/시작초/길이를 선택합니다. 첫 작업은 모델 다운로드 및 초기화로 오래 걸릴 수 있습니다. CPU 기본값은 수 분 이상 걸릴 수 있고 RAM/모델 저장 공간을 별도로 필요로 합니다. 호환 GPU가 설정된 경우 `--device cuda` 또는 지원되는 Mac에서 `--device mps`를 직접 선택할 수 있습니다. 클라우드 Linux CPU에서는 아래 검증 환경으로 직접 합성한 8초 오디오의 실제 분리가 성공했습니다. GPU와 사용자별 설치 환경은 검증하지 않았습니다.

```bash
# 캐시 위치 / 포트 선택 (바인딩 주소는 변경 불가)
.venv/bin/python companion.py --allow-model-download --cache-dir ./local-cache --port 8766
```

### 관리 환경의 승인된 기존 프록시가 필요한 경우

기본값은 프록시 환경변수를 상속하지 않습니다. 회사/클라우드 환경이 이미 설정한 **신뢰할 수 있는 승인된 egress 프록시** 없이는 일반 인터넷 연결이 되지 않는 경우에만 다음 옵션을 직접 선택합니다.

```bash
.venv/bin/python companion.py --allow-model-download --trust-env-proxy
```

이 옵션은 기존 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 및 소문자 변형만 자식 도구에 전달합니다. 새 주소를 지정하거나 네트워크 보안 설정을 바꾸지 않으며, 웹 UI나 작업 API에서 프록시를 받을 수 없습니다. 프록시 URL에 자격증명이 포함되어 있다면 자식 도구도 그 값을 받으므로 **환경 설정을 신뢰할 때만** 선택하세요. 앱은 해당 값을 상태 응답에 노출하지 않지만, 외부 도구 오류에는 민감한 값이 포함될 수 있으므로 오류 전문을 공개하지 마세요. 계정 토큰·쿠키·임의 인증서/Python 설정은 계속 제외합니다. 접근 거부/지역/로그인/봇 제한을 우회하는 용도가 아니며 그런 오류는 중단합니다.

원하는 권한 있는 녹음의 **짧은 구간부터** 사용하세요. 전체 취득 과정은 원본 길이/크기 상한을 적용하고, 분리 및 재생은 선택 구간만 사용합니다. 취득 중 사이트 정책/도구 호환성 오류는 그대로 멈춥니다. 파일 업로드란 인터넷 업로드가 아니라 자신의 loopback 서버로 읽어 들이는 것을 의미합니다.

## 저장과 보안 경계

- 바인딩은 `127.0.0.1`로 고정. Host/Origin, Fetch Metadata, 매 실행 생성 CSRF 토큰을 검사하며 CORS를 열지 않습니다.
- HTTPS YouTube 지정 호스트 + 11자리 영상 ID만 허용하고 URL을 재구성합니다. 임의 URL/인자/플러그인/다운로드 명령/경로를 받지 않습니다.
- 다운로드 설정/쿠키/계정은 상속하지 않습니다. 프록시도 기본적으로 제외하며 `--trust-env-proxy`를 선택한 경우에만 위 allowlist의 기존 승인된 환경 경로를 상속합니다. yt-dlp 원격 컴포넌트 자동 취득도 비활성화하고 설치된 ejs와 Deno를 사용합니다.
- 미디어 검사/변환은 로컬 file 프로토콜과 지원 컨테이너만 허용합니다. URL 재생목록/FFmpeg 네트워크 입력은 거부합니다. 이것은 OS 샌드박스가 아니므로 신뢰할 수 없는 바이너리/가중치/고의적 악성 파일을 실행하지 마세요.
- 동시에 한 작업만 보유합니다. 기존 결과를 삭제해야 새 작업을 만들 수 있습니다. 동시 프로세스 및 프레임워크 실행은 한 작업으로 한정합니다.
- 작업 폴더 한도 512 MiB, 취득 5분, 일반 변환 2분, 분리 30분 등 단계별 제한을 적용합니다. 주기 검사 한도는 하드 OS 디스크 쿼터가 아니며 순간 초과 가능성이 있습니다. **모델 캐시는 512 MiB 작업 상한과 별도**입니다.
- 기본 저장: `~/.cache/music-stem-companion/`. `session-…` 하위에 작업을 만들고 완료 시 원본/중간파일을 제거하여 4개 스템만 남깁니다. 앱의 삭제 버튼 또는 정상 Ctrl+C 종료 시 현재 세션 데이터를 삭제합니다. 브라우저에서 이미 다운로드한 사본은 자동 삭제되지 않습니다.
- 비정상 종료 시 남은 `session-…` 폴더는 서버를 종료한 상태에서 직접 삭제할 수 있습니다. `models/`는 사용자가 허용하여 받은 모델 캐시이며 자동 삭제하지 않습니다. 영구 자격증명은 저장하지 않습니다.
- 웹앱은 로컬 오디오를 외부로 전송하지 않습니다. YouTube 취득과 허용된 모델 다운로드 자체는 각각 해당 서비스에 네트워크 요청을 보냅니다.

## 검증 및 개발

```bash
python -m unittest discover -s tests -v
python -m py_compile companion.py
node --check static/app.js
node --test tests/test_ui.cjs
```

자동 회귀 테스트는 합성 오디오와 모의 취득/모델을 사용합니다. 생성된 모의 스템은 분리 품질의 증거가 아닙니다. 별도 클라우드 실행에서는 공식 PyPI Demucs 4.1.0, CPU PyTorch 2.12.0, NumPy 2.3.5를 가상환경에 설치하고, 직접 합성한 8초 음악을 실제 HTTP 업로드→FFmpeg 변환→Demucs 실행 경로로 시험했습니다. **기본 직접 연결은 DNS 실패로 멈췄고, 기존 승인된 환경 프록시를 명시적으로 허용한 실행에서는 실제 추론·4개 스템 생성·onset JSON·HTTP 조회/삭제가 성공했습니다.** 8초 입력은 약 20초에 처리됐으며 피크 자식 프로세스 RSS는 약 1.14 GiB였습니다. 이는 합성 입력의 작동 검증이지 실곡 분리 품질 보장은 아닙니다. 자세한 실행 명령·결과는 `VERIFICATION.md`를 참조하세요.

**미검증:** 사용자의 Windows/macOS/Linux 설치, GPU 추론, 실곡 취득·분리 품질/속도, 실제 브라우저/오디오 장치의 청감·지연, YouTube의 향후 사이트 변경. 한 클라우드 환경의 합성 입력 성공은 사용자 장치 호환성이나 실곡 품질의 증거가 아닙니다. YouTube 추출 실패를 접근제한 우회로 복구하지 않습니다.

## 출처와 재사용

작은 Python HTTP 서버/프로세스 래퍼와 에너지 onset 추정기는 이 프로젝트에서 작성했습니다. 외부 프로젝트의 코드를 통째로 복사하지 않습니다. 기존 음악 연습 UI의 구조를 같은 프로젝트의 로컬 화면으로 맞추었습니다.

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 설치된 Python 명령을 사용. Python 소스/wheel은 Unlicense; 번들 실행파일/의존성은 별도 라이선스가 있습니다.
- [Demucs 유지관리 저장소](https://github.com/adefossez/demucs) — 설치된 CLI로 4개 스템 분리. 코드는 MIT, 가중치 조건은 별도 확인 필요.
- [FFmpeg](https://ffmpeg.org/legal.html) — 별도 설치 바이너리. 빌드 구성에 따라 LGPL/GPL 조건이 다릅니다.
- [StemRoller](https://github.com/stemrollerapp/stemroller), 특히 [`processQueue.js`](https://github.com/stemrollerapp/stemroller/blob/main/main-src/processQueue.js) — 취득→분리의 직렬 큐/취소/캐시 설계 참고. Unlicense 또는 MIT No Attribution. 해당 소스를 벤더링하지 않았습니다.
- [DrumMate Chart](https://github.com/sashyo/drummate-chart), [librosa onset](https://github.com/librosa/librosa/blob/main/librosa/onset.py) — 분리된 드럼 기반 타이밍 안내의 조사 자료. 이 버전은 해당 코드를 복사하거나 librosa를 의존성으로 사용하지 않습니다.

이 프로젝트의 새 원본 코드에는 아직 별도의 오픈소스 라이선스를 선택하지 않았습니다. 공개 저장소에 올린다는 사실 자체가 재사용 라이선스 부여는 아닙니다. 위 외부 소프트웨어·가중치·음원의 라이선스와 권리는 각각 따로 유지됩니다.
