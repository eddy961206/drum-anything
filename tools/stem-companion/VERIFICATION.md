# Verification — 2026-10-30

## Passed in the development environment

- `python -m unittest discover -s tests -v`: **38 / 38** tests passed.
- `node --test tests/test_ui.cjs`: **18 / 18** tests passed.
- `python -m py_compile companion.py`: passed.
- `node --check static/app.js`: passed.
- `python companion.py --check`: runs without installing/importing inference models and accurately reports absent Demucs / yt-dlp / yt-dlp-ejs / Deno and missing explicit model policy. FFmpeg and FFprobe were already available.

Python coverage: single-YouTube URL canonicalization and rejection; excerpt/duration/size limits; metadata access restrictions; safe paths including symlinks; one-job reservation; missing dependencies; rights checkbox validation; cancellation; deletion; environment credential/proxy filtering; fixed downloader flags; explicit offline model-library environment and local Demucs repository selection; real synthetic subprocess success/error/output cap/timeout/cancellation; mocked YouTube acquisition; source identity checking; mocked four-stem pipeline; synthetic drum pulses/onset detector; synthetic **real FFmpeg normalization and output processing with the Demucs step mocked**; local-loopback HTTP Host/Origin/CSRF/body limits/security headers/routing.

UI coverage uses Node DOM/AudioContext mocks: static IDs/assets; local-file vs YouTube dependency readiness; numeric limits; local media-path restrictions; actual stage/action rendering; four-stem decode and scheduled alignment; drummer mode and live gains; pause/resume; repeated/interrupted resume; looping/end behavior; reset; browser back/forward-cache recovery and deleted-job reconciliation. Mocks do not establish browser audio output quality.

The final test run did **not** download real music, contact YouTube, install packages, download model weights, or execute Demucs. Synthetic test files are temporary and removed. Tests bind only their own ephemeral `127.0.0.1` port in the development environment, not a user's workstation.

## Blocked / not performed

- Real-browser visual rendering was not verified. Automated UI checks use mocks, not a rendered browser.
- No application was installed or run on the user's device.
- No genuine YouTube acquisition, model download, or model inference was performed.
- Windows/macOS installation, process-tree cancellation on Windows, GPU compatibility, real browser/device audio latency and listening quality remain unverified.
- The source points to the official Demucs `v4.1.0` release, whose existence and documented CLI/model-repository options were checked. Its installation and runtime compatibility were not exercised here. yt-dlp behavior depends on the installed version and current YouTube behavior; normal extraction errors stop the job.

## Publication boundary

Publish only source/docs/tests listed in `SOURCE_MANIFEST.json`. Do not publish virtual environments, cache directories, generated test audio, model weights, third-party binaries, bytecode, or credentials. Original-code project licensing is not selected; external dependency/model/music rights remain separate. Public availability alone is not a blanket reuse license.
