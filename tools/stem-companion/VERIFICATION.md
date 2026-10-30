# Verification — 2026-10-30

## 현재 변경 검증 범위

Windows에서 합성 51초 입력과 모의 모델로 조각 연결을 확인했다. 브라우저에서 65초 합성 스템으로 조각 경계·탐색·전체 반복·19–23초 구간 반복을 확인했다. 여섯 CC0 드럼 파일을 브라우저가 디코딩하고 패드 입력에 반응하는 것을 확인했다.

### Windows 실제 전체 곡 검증

- 2026-10-30 KST에 사용자가 제공한 공개 YouTube 영상의 오디오를 로컬에서 취득하고 Demucs `htdemucs`, Torch 2.12.0 CPU로 실제 분리했다. 원본과 결과 길이는 **204.3356초**였다.
- 시작 작업 폴더 생성 시각 15:42:59, 결과 폴더 갱신 시각 15:54:14를 기준으로 약 **11분 15초** 걸렸다. 이 수치는 당시 다른 작업이 실행 중인 Windows PC에서 측정한 값이며 다른 기기의 처리 시간은 보장하지 않는다.
- 45초 간격과 5초 겹침을 둔 조각 5개를 분리하고 이어 붙였다. 네 PCM16 스테레오 WAV는 각각 36,044,878바이트이며 프레임 수가 같았다. 공통 출력 보정은 0.98이고 추정 드럼 타격 지점은 262개였다.
- 실제 브라우저에서 3:24 결과를 불러오고 드러머 모드가 원래 드럼을 음소거하는 것을 확인했다. 2:59–3:03 구간이 3:01을 지나 2:59로 되돌아왔다. 탐색 직후 반복 설정을 바꿀 때 재생 준비가 취소되던 문제를 수정하고 다시 확인했다. 브라우저 콘솔에 관련 경고나 오류는 없었다.
- 같은 원본의 10–40초를 이전 30초 결과 및 새 전체 곡 결과와 비교했다. 네 스템을 합한 파형의 원본 대비 재구성 SNR은 이전 27.33 dB, 새 결과 32.91 dB였다. 새 결과는 원본에도 공통 보정값 0.98을 적용해 비교했다. 두 실행의 입력 조각 길이와 모델의 랜덤 이동이 달라 이 차이를 한 원인으로 단정할 수 없다. 네 연결 구간 5초의 재구성 SNR은 26.31–35.24 dB였다.
- 이 수치와 파형 확인은 네 파트의 합이 원본에 가까운지 보여줄 뿐, 드럼에 다른 악기가 섞였는지 또는 청감이 자연스러운지 증명하지 않는다. 분리 전 개별 악기 정답과 직접 청취 입력이 없어 **실제 분리 품질, 청감과 출력 지연은 미검증**이다.

최신 Windows 회귀 검사는 Python 49건 중 48건 통과, 심볼릭 링크 권한이 없어 1건 건너뜀, Node UI 27건 통과다. 아래 Linux 8초 검증과 그 한계는 이전 구현의 기록이다.

## Previous Linux regression checks

- Python unit tests: **42 / 42** passed.
- Node DOM/AudioContext tests: **18 / 18** passed.
- `python -m py_compile companion.py` and `node --check static/app.js`: passed.
- `companion.py --check` checks package metadata (including Demucs, Torch, NumPy), executable presence and explicit model policy without importing heavy runtimes or downloading models. Presence does not prove runtime compatibility.

Python coverage includes core-runtime readiness, local readiness without YouTube tools, URL/metadata restrictions, size/duration bounds, safe paths/symlinks, one-job reservation, cancellation/deletion, default credential/proxy filtering, explicit trusted-proxy allowlisting, fixed downloader arguments, offline model policy, synthetic subprocess lifecycle, mocked acquisition/model execution, synthetic FFmpeg processing, onset detection, and loopback Host/Origin/CSRF/body/routing protections.

UI mocks cover asset contracts, readiness, input bounds, local media paths, accurate status, aligned four-stem playback, mix/volume, pause/resume, looping, cleanup and back/forward-cache recovery. Mocks do not establish rendering or listening quality.

The regression suite uses synthetic data and mocked acquisition/inference. It does not contact YouTube, install packages, download weights or run Demucs. Temporary test files are removed and HTTP tests use an ephemeral loopback port. The separate integration test below did run Demucs.

## Real synthetic-input integration test

**Actual CPU separation passed through HTTP upload → FFmpeg → Demucs → four aligned stems → onset JSON → HTTP retrieval and deletion. No model or subprocess step was mocked in this integration test.**

Tested runtime: Linux x86_64; Python **3.12.14**; FFmpeg/FFprobe **7.1.5**; Demucs **4.1.0**; Torch **2.12.0+cpu**; NumPy **2.3.5**. Packages were installed in an isolated virtual environment, not global Python or a user's device. Core imports and `pip check` passed. GPU inference was not tested.

Reproducibility commands for an isolated environment:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --index-url https://download.pytorch.org/whl/cpu 'torch==2.12.0'
.venv/bin/python -m pip install --index-url https://pypi.org/simple 'demucs==4.1.0' 'numpy==2.3.5'
.venv/bin/python -m pip check
.venv/bin/python -c 'import torch, numpy, demucs.separate; print(torch.__version__, numpy.__version__)'
.venv/bin/python companion.py --check --allow-model-download
```

Demucs 4.1.0 initially failed import because its Linux dependency metadata did not install NumPy. Instructions now request NumPy explicitly and readiness checks require Torch/NumPy metadata. The official [Demucs PyPI wheel](https://pypi.org/project/demucs/4.1.0/) matched its published SHA-256: `4916a804702033ce934a6cdfa7e38dde03f7a7a6e85f41d0120eefe9e2966758`.

### Network configuration and explicit opt-in

The initial direct-network attempt failed during official model download with a DNS-resolution error. It took **26.713 seconds**, produced no model or stems, and was not successful inference.

The successful run used an already-configured, approved egress route with the default-off CLI option `--trust-env-proxy`, alongside `--allow-model-download`. No new proxy, credentials, certificate override or network-security change was introduced. The option forwards only existing `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase variants. It cannot be set through the browser/API; account tokens and arbitrary certificate/Python settings remain excluded. Defaults still strip proxy variables. See the README for trust and error-log precautions.

This option supports an existing authorized network configuration, not access-restriction bypass. In that Linux environment, YouTube metadata checks initially encountered DNS/TLS failures. A separate diagnostic using existing platform trust then reached HTTP 429 and a sign-in/bot-verification restriction. **No media was obtained in that Linux test.** No authentication or access-restriction bypass was attempted. The diagnostic did not add custom certificate support to the published application. The later Windows result is described above.

### Input, execution and results

Input: original deterministic **8.000-second, 44.1 kHz stereo PCM16** synthesis of bass, chords, melody, kick, noise snare and hi-hats. No third-party song or human vocal was used. Input SHA-256: `e0db9c1645310736a9bf46a7bef5b4411b25d8c3d5ee51329b18ea57a837ac3a`.

The integration harness served real UI assets, obtained a session token, uploaded the file and polled the job. FFprobe validation and FFmpeg normalization passed. Demucs used `-n htdemucs -d cpu --shifts 1 -j 0` with job-local input/output paths. Its normal official model loader downloaded **84,141,911 bytes (80.24 MiB)** of weights and verified the filename checksum. No weights or generated media are published.

- End-to-end elapsed: **20.001 seconds**.
- Demucs subprocess: **17.031 seconds**, including download/load and inference; **not a pure inference benchmark**.
- Peak single-child RSS from Linux `getrusage`: **1,195,816 KiB (~1.14 GiB)**, not aggregate server-plus-all-children memory.

| Stem | Duration | Frames | Format | RMS | Peak |
| --- | ---: | ---: | --- | ---: | ---: |
| vocals | 8.000 s | 352,800 | 44.1 kHz stereo PCM16 | 0.000811 | 0.001434 |
| bass | 8.000 s | 352,800 | 44.1 kHz stereo PCM16 | 0.074288 | 0.130066 |
| drums | 8.000 s | 352,800 | 44.1 kHz stereo PCM16 | 0.043658 | 0.493652 |
| other | 8.000 s | 352,800 | 44.1 kHz stereo PCM16 | 0.038854 | 0.130493 |

All samples were finite, all stems nonzero, and frame counts identical. Each retrieved WAV was 1,411,278 bytes. Low vocal energy is expected without human vocals; this is not a vocal-quality test. The actual drum stem yielded **31** ordered, in-bounds onset estimates.

The harness verified `ready`, retrieved all four WAVs over HTTP, confirmed only four stems remained in the job folder, deleted the job through the protected endpoint and shut down the server.

## Limits of the previous Linux test

- No app was installed or run on the user's device.
- Genuine YouTube acquisition and real-song separation quality remain unverified.
- Windows/macOS setup, Windows process-tree cancellation and GPU compatibility remain unverified.
- Actual browser rendering, audio output, listening quality and device latency remain unverified.
- Future package/site behavior can differ; acquisition errors stop the job rather than trigger an access workaround.

**Synthetic success establishes pipeline operation, not real-song quality, score accuracy or user-device compatibility.**

## Publication boundary

Only files listed in `SOURCE_MANIFEST.json` are published, including six attributed CC0 drum recordings. Virtual environments, model weights, executables, user music, generated stems, caches, detailed execution reports, credentials and bytecode are excluded. No project license has been selected; external dependency/model/music rights remain separate.
