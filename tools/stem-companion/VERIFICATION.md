# Verification — 2026-10-30

## 현재 변경 검증 범위

아래 Linux 8초 검증은 이전 구현의 기록이다. 전체 곡 분할 처리, float 출력과 공통 볼륨 보정은 별도로 실제 모델 검증이 필요하다. Windows에서 합성 51초 입력과 모의 모델로 조각 연결을 확인했다. 브라우저에서 65초 합성 스템으로 조각 경계·탐색·전체 반복·19–23초 구간 반복을 확인했다. 여섯 CC0 드럼 파일을 브라우저가 디코딩하고 패드 입력에 반응하는 것을 확인했다. 실제 청감은 확인하지 못했다.

## Automated regression checks

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

This option supports an existing authorized network configuration, not access-restriction bypass. YouTube metadata checks initially encountered DNS/TLS failures. A separate diagnostic using existing platform trust then reached HTTP 429 and a sign-in/bot-verification restriction. **No media was obtained and successful YouTube acquisition remains unverified.** No authentication or access-restriction bypass was attempted. The diagnostic did not add custom certificate support to the published application.

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

## Remaining limits

- No app was installed or run on the user's device.
- Genuine YouTube acquisition and real-song separation quality remain unverified.
- Windows/macOS setup, Windows process-tree cancellation and GPU compatibility remain unverified.
- Actual browser rendering, audio output, listening quality and device latency remain unverified.
- Future package/site behavior can differ; acquisition errors stop the job rather than trigger an access workaround.

**Synthetic success establishes pipeline operation, not real-song quality, score accuracy or user-device compatibility.**

## Publication boundary

Only files listed in `SOURCE_MANIFEST.json` are published, including six attributed CC0 drum recordings. Virtual environments, model weights, executables, user music, generated stems, caches, detailed execution reports, credentials and bytecode are excluded. No project license has been selected; external dependency/model/music rights remain separate.
