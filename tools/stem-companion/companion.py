#!/usr/bin/env python3
"""Local-only stem practice companion. Original orchestration; external tools stay external."""
from __future__ import annotations

import argparse
import array
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_UPLOAD = 100 * 1024 * 1024
MAX_SOURCE_SECONDS = 900
MAX_EXCERPT_SECONDS = 180
MAX_JOB_BYTES = 512 * 1024 * 1024
STEMS = ('vocals', 'bass', 'drums', 'other')
TERMINAL = {'ready', 'failed', 'cancelled', 'dependency_missing'}
FORMATS = 'wav,mp3,flac,mov,ogg,matroska,webm,aac,aiff'
STATIC = Path(__file__).resolve().parent / 'static'


class Problem(Exception):
    pass


class Cancelled(Problem):
    pass


def youtube_url(value):
    """Return a canonical one-video URL. Never forward an arbitrary host/query."""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        raise Problem('Use one ordinary public https YouTube video URL.')
    try:
        u = urlsplit(value)
        if u.scheme != 'https' or u.username or u.password or u.port or u.fragment:
            raise ValueError()
        q = parse_qs(u.query, keep_blank_values=True, strict_parsing=True)
        if any(k not in {'v', 't', 'si', 'feature'} or len(v) != 1 for k, v in q.items()):
            raise ValueError()
        if u.hostname == 'youtu.be':
            if 'v' in q:
                raise ValueError()
            vid = u.path[1:]
        elif u.hostname in {'youtube.com', 'www.youtube.com', 'm.youtube.com'}:
            if u.path == '/watch':
                vid = q.get('v', [''])[0]
            elif u.path.startswith('/shorts/') and 'v' not in q:
                vid = u.path[len('/shorts/'):]
            else:
                raise ValueError()
        else:
            raise ValueError()
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
            raise ValueError()
    except (ValueError, TypeError):
        raise Problem('Only a single public YouTube video is supported; no playlists, redirects or other sites.') from None
    return f'https://www.youtube.com/watch?v={vid}'


def excerpt(start, duration):
    try:
        if isinstance(start, bool) or isinstance(duration, bool):
            raise ValueError()
        start, duration = float(start), float(duration)
        if not (math.isfinite(start) and math.isfinite(duration)):
            raise ValueError()
        if not (0 <= start < MAX_SOURCE_SECONDS and 1 <= duration <= MAX_EXCERPT_SECONDS):
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        raise Problem('Excerpt start must be 0–899 seconds; length must be 1–180 seconds.') from None
    return start, duration


def safe_child(root: Path, *parts: str) -> Path:
    root = root.resolve()
    candidate = root.joinpath(*parts).resolve()
    if candidate == root or root not in candidate.parents:
        raise Problem('Invalid path.')
    return candidate


def validate_youtube_metadata(info):
    if not isinstance(info, dict) or info.get('_type', 'video') != 'video' or info.get('entries'):
        raise Problem('A single ordinary public video is required.')
    if info.get('availability') != 'public' or info.get('age_limit', 0) != 0:
        raise Problem('Restricted, age-gated, private or paid videos are not supported.')
    if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming') or info.get('has_drm'):
        raise Problem('Live, upcoming or DRM media are not supported.')
    try:
        duration = float(info['duration'])
        size = float(info.get('filesize') or info.get('filesize_approx') or 0)
        if not math.isfinite(duration) or not 0 < duration <= MAX_SOURCE_SECONDS or not math.isfinite(size) or not 0 <= size <= MAX_UPLOAD:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise Problem('Source duration/size is unknown or exceeds 15 minutes / 100 MiB.') from None
    return duration


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


@dataclass
class Config:
    cache: Path
    allow_model_download: bool = False
    model_repo: Path | None = None
    device: str = 'cpu'
    trust_env_proxy: bool = False

    def dependencies(self):
        # Demucs 4.1.0 imports NumPy on every platform, but its Linux package
        # metadata does not require it. Check core runtime presence explicitly.
        versions = {name: package_version(name) for name in ('demucs', 'torch', 'numpy', 'yt-dlp', 'yt-dlp-ejs')}
        for name in ('ffmpeg', 'ffprobe', 'deno'):
            versions[name] = shutil.which(name)
        missing = [name for name in ('ffmpeg', 'ffprobe', 'demucs', 'torch', 'numpy') if not versions[name]]
        if not self.allow_model_download and self.model_repo is None:
            missing.append('model policy: choose --model-repo or explicitly --allow-model-download')
        if self.model_repo and not self.model_repo.is_dir():
            missing.append('model repository directory')
        extra = [name for name in ('yt-dlp', 'yt-dlp-ejs', 'deno') if not versions[name]]
        return {'ready': not missing, 'youtube_ready': not missing and not extra,
                'missing': missing, 'youtube_missing': extra, 'versions': versions,
                'model_download_allowed': self.allow_model_download,
                'trusted_environment_proxy': self.trust_env_proxy}


@dataclass
class Job:
    id: str
    directory: Path
    start: float
    length: float
    url: str | None = None
    status: str = 'queued'
    message: str = 'Waiting for worker.'
    error: str | None = None
    duration: float = 0
    onsets: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen | None = field(default=None, repr=False)

    def public(self):
        return {'id': self.id, 'status': self.status, 'message': self.message,
                'error': self.error, 'duration': self.duration, 'onsets': self.onsets,
                'stems': {s: f'/media/{self.id}/{s}.wav' for s in STEMS} if self.status == 'ready' else {}}


class Manager:
    def __init__(self, config: Config):
        self.config = config
        config.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.session_dir = config.cache / ('session-' + uuid.uuid4().hex)
        self.session_dir.mkdir(mode=0o700)
        self.lock = threading.RLock()
        self.job: Job | None = None
        self.worker: threading.Thread | None = None
        self.closed = False

    def current(self):
        with self.lock:
            return self.job.public() if self.job else None

    def reserve(self, start, duration, rights, url=None):
        if rights is not True:
            raise Problem('Confirm source rights and usage limitations before importing.')
        start, duration = excerpt(start, duration)
        url = youtube_url(url) if url is not None else None
        with self.lock:
            if self.closed or self.job is not None:
                raise Problem('One job at a time. Delete the previous job before starting another.')
            jid = uuid.uuid4().hex
            path = safe_child(self.session_dir, jid)
            path.mkdir(mode=0o700)
            job = self.job = Job(jid, path, start, duration, url)
            deps = self.config.dependencies()
            missing = deps['missing'] + (deps['youtube_missing'] if url else [])
            if missing:
                job.status = 'dependency_missing'
                job.error = job.message = 'Missing: ' + ', '.join(missing)
            return job

    def start(self, job):
        with self.lock:
            if job.status in TERMINAL:
                return
            self.worker = threading.Thread(target=self._work, args=(job,), daemon=True)
            self.worker.start()

    def stage(self, job, status, message):
        with self.lock:
            if job.cancel.is_set():
                raise Cancelled('Cancelled by user.')
            job.status, job.message = status, message

    def environment(self):
        # Never inherit account credentials, Python injection or user tool config.
        # Managed environments may require their existing approved egress proxy;
        # passing that limited setting is an explicit process-level opt-in only.
        env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL') if k in os.environ}
        if self.config.trust_env_proxy:
            proxy_names = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                           'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')
            env.update({k: os.environ[k] for k in proxy_names if k in os.environ})
        home = self.config.cache / 'tool-home'
        home.mkdir(exist_ok=True, mode=0o700)
        temporary = home / 'tmp'
        temporary.mkdir(exist_ok=True, mode=0o700)
        env.update(TMPDIR=str(temporary), TEMP=str(temporary), TMP=str(temporary), HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(home / 'config'),
                   XDG_CACHE_HOME=str(home / 'cache'), HF_HOME=str(self.config.cache / 'models' / 'hf'),
                   TORCH_HOME=str(self.config.cache / 'models' / 'torch'), PYTHONNOUSERSITE='1',
                   HF_HUB_DISABLE_TELEMETRY='1', HF_HUB_DISABLE_IMPLICIT_TOKEN='1', DO_NOT_TRACK='1')
        if not self.config.allow_model_download:
            # Model-library controls only: ordinary authorized yt-dlp requests are unaffected.
            # Demucs also receives a fixed local --repo, so its legacy Torch remote fallback is not selected.
            env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        return env

    @staticmethod
    def terminate(proc):
        if proc.poll() is not None:
            return
        try:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
            else:
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    proc.kill()
                else:
                    os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        except ProcessLookupError:
            pass

    @staticmethod
    def disk_bytes(directory):
        total = 0
        for path in directory.rglob('*'):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except FileNotFoundError:
                pass  # Downloader fragments can be renamed between stat calls.
        return total

    def run(self, job, args, timeout=120, output_limit=1024 * 1024):
        if job.cancel.is_set():
            raise Cancelled('Cancelled by user.')
        output = job.directory / 'command.out'
        errors = job.directory / 'command.err'
        started = time.monotonic()
        kwargs = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        with output.open('wb') as out, errors.open('wb') as err:
            proc = subprocess.Popen(args, cwd=job.directory, env=self.environment(), stdin=subprocess.DEVNULL,
                                    stdout=out, stderr=err, shell=False, **kwargs)
            with self.lock:
                job.process = proc
            try:
                while proc.poll() is None:
                    if job.cancel.wait(0.15):
                        raise Cancelled('Cancelled by user.')
                    if time.monotonic() - started > timeout:
                        raise Problem(f'Operation exceeded {timeout} seconds and was stopped.')
                    if output.stat().st_size > output_limit or errors.stat().st_size > 2 * 1024 * 1024:
                        raise Problem('Tool output exceeded its safety limit.')
                    used = self.disk_bytes(job.directory)
                    if used > MAX_JOB_BYTES:
                        raise Problem('Job exceeded the 512 MiB temporary-disk limit.')
                if job.cancel.is_set():
                    raise Cancelled('Cancelled by user.')
            finally:
                if proc.poll() is None:
                    self.terminate(proc)
                with self.lock:
                    job.process = None
        if output.stat().st_size > output_limit or errors.stat().st_size > 2 * 1024 * 1024:
            raise Problem('Tool output exceeded its safety limit.')
        if self.disk_bytes(job.directory) > MAX_JOB_BYTES:
            raise Problem('Job exceeded the 512 MiB temporary-disk limit.')
        if proc.returncode:
            with errors.open('rb') as error_stream:
                error_stream.seek(max(0, errors.stat().st_size - 2400))
                detail = error_stream.read(2400).decode(errors='replace')[-1200:]
            # Surface normal errors; never suggest cookies, bypasses or alternate download routes.
            raise Problem(f'{Path(args[0]).name} failed (exit {proc.returncode}). {detail}')
        return output.read_text(errors='replace')

    def ytdlp_args(self):
        args = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-plugin-dirs', '--no-playlist',
                '--no-cache-dir', '--no-remote-components', '--xff', 'never',
                '--no-progress', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1',
                '--format', 'bestaudio[ext=m4a]/bestaudio', '--js-runtimes', 'deno']
        if not self.config.trust_env_proxy:
            args += ['--proxy', '']
        return args

    def acquire(self, job):
        self.stage(job, 'acquiring', 'Checking the public single-video source; access restrictions stop the job.')
        meta = self.run(job, self.ytdlp_args() + ['--dump-single-json', '--skip-download', '--', job.url],
                        timeout=90, output_limit=8 * 1024 * 1024)
        info = json.loads(meta)
        validate_youtube_metadata(info)
        if info.get('id') != job.url.split('=')[-1]:
            raise Problem('Unexpected video identity returned by downloader.')
        self.stage(job, 'acquiring', 'Acquiring bounded public audio locally (100 MiB / 15-minute source cap).')
        self.run(job, self.ytdlp_args() + ['--max-filesize', str(MAX_UPLOAD), '--no-part',
                 '--output', str(job.directory / 'source.%(ext)s'), '--', job.url], timeout=300)
        sources = [p for p in job.directory.glob('source.*') if p.is_file()]
        if len(sources) != 1 or not 0 < sources[0].stat().st_size <= MAX_UPLOAD:
            raise Problem('No bounded audio file was acquired.')
        return sources[0]

    def probe(self, job, source):
        data = json.loads(self.run(job, ['ffprobe', '-v', 'error', '-protocol_whitelist', 'file',
                   '-format_whitelist', FORMATS, '-show_entries', 'format=duration:stream=codec_type,channels,sample_rate',
                   '-of', 'json', str(source)], timeout=30))
        try:
            duration = float(data['format']['duration'])
            audios = [s for s in data['streams'] if s['codec_type'] == 'audio']
            if not 0 < duration <= MAX_SOURCE_SECONDS or not audios:
                raise ValueError()
            if int(audios[0].get('channels', 0)) not in range(1, 9):
                raise ValueError()
            if not 8000 <= int(audios[0].get('sample_rate', 0)) <= 192000:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise Problem('Unsupported media metadata: require audio, 1–8 channels, 8–192 kHz, ≤15 minutes.') from None
        return duration

    def _work(self, job):
        try:
            source = self.acquire(job) if job.url else job.directory / 'source.upload'
            if not source.is_file() or not 0 < source.stat().st_size <= MAX_UPLOAD:
                raise Problem('The audio file is empty, missing or over 100 MiB.')
            self.stage(job, 'normalizing', 'Validating media and preparing the selected excerpt.')
            source_duration = self.probe(job, source)
            if job.start >= source_duration:
                raise Problem('Excerpt start is after the end of this recording.')
            length = min(job.length, source_duration - job.start)
            self.run(job, ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file',
                      '-format_whitelist', FORMATS, '-ss', str(job.start), '-i', str(source),
                      '-t', str(length), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', '44100',
                      '-c:a', 'pcm_s16le', str(job.directory / 'excerpt.wav')], timeout=120)
            self.stage(job, 'separating', 'Demucs is separating four stems. CPU inference can take several minutes.')
            args = [sys.executable, '-m', 'demucs', '-n', 'htdemucs', '-d', self.config.device,
                    '--shifts', '1', '-j', '0', '-o', str(job.directory / 'separated')]
            if self.config.model_repo:
                args += ['--repo', str(self.config.model_repo.resolve())]
            args.append(str(job.directory / 'excerpt.wav'))
            self.run(job, args, timeout=1800)
            self.stage(job, 'analyzing', 'Checking aligned stems and estimating drum-hit timestamps.')
            lengths = []
            for name in STEMS:
                src = safe_child(job.directory, 'separated', 'htdemucs', 'excerpt', name + '.wav')
                if not src.is_file():
                    raise Problem(f'Demucs did not produce {name}.wav.')
                dst = job.directory / (name + '.wav')
                # Stable PCM16 / stereo output, whatever the installed Demucs writer uses.
                self.run(job, ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file',
                               '-format_whitelist', 'wav', '-i', str(src), '-t', str(length), '-ac', '2', '-ar', '44100',
                               '-c:a', 'pcm_s16le', str(dst)], timeout=60)
                with wave.open(str(dst), 'rb') as wav:
                    lengths.append(wav.getnframes())
            if max(lengths) - min(lengths) > 441:
                raise Problem('Stem alignment validation failed.')
            job.duration = min(lengths) / 44100
            if not 0 < job.duration <= MAX_EXCERPT_SECONDS + 0.1:
                raise Problem('Invalid output duration.')
            job.onsets = detect_onsets(job.directory / 'drums.wav', job.cancel)
            # Successful output keeps only four stems; no source/metadata or command logs retained.
            for child in job.directory.iterdir():
                if child.name not in {s + '.wav' for s in STEMS}:
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
            self.stage(job, 'ready', 'Four stems are ready. Drum dots are estimated onsets, not a verified score.')
        except Cancelled as exc:
            with self.lock:
                job.status, job.error, job.message = 'cancelled', None, str(exc)
        except Exception as exc:
            with self.lock:
                job.status, job.error, job.message = 'failed', str(exc), 'Job stopped. Review the error or delete this job.'

    def cancel_job(self, jid):
        with self.lock:
            job = self._get(jid)
            if job.status not in TERMINAL:
                job.cancel.set()
                job.message = 'Cancellation requested; waiting for the process tree to stop.'
            return job.public()

    def _get(self, jid):
        if not self.job or not secrets.compare_digest(self.job.id, jid):
            raise Problem('Job not found.')
        return self.job

    def delete(self, jid):
        with self.lock:
            job = self._get(jid)
            if job.status not in TERMINAL or (self.worker and self.worker.is_alive()):
                raise Problem('Cancel and wait until the worker stops before deleting.')
            shutil.rmtree(job.directory)
            self.job = None

    def close(self):
        with self.lock:
            self.closed = True
            if self.job:
                self.job.cancel.set()
        if self.worker:
            self.worker.join(timeout=15)
        if not self.worker or not self.worker.is_alive():
            shutil.rmtree(self.session_dir, ignore_errors=True)


def detect_onsets(path: Path, cancel=None):
    """Original standard-library energy-rise detector. Timing cues, not drum transcription."""
    energies = []
    with wave.open(str(path), 'rb') as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() not in (1, 2):
            raise Problem('Onset detector requires PCM16 mono/stereo WAV.')
        rate, channels = wav.getframerate(), wav.getnchannels()
        hop = max(1, round(rate * 0.01))
        while raw := wav.readframes(hop):
            if cancel and cancel.is_set():
                raise Cancelled('Cancelled by user.')
            samples = array.array('h', raw)
            if sys.byteorder != 'little':
                samples.byteswap()
            energies.append(math.sqrt(sum(v * v for v in samples) / max(1, len(samples))) / 32768)
    if not energies or max(energies) < 0.003:
        return []
    peaks, last = [], -1.0
    for i in range(2, len(energies) - 1):
        local = energies[max(0, i - 15):i]
        baseline = sum(local) / len(local)
        t = i * hop / rate
        if (energies[i] > max(0.008, baseline * 1.7) and energies[i] > energies[i - 1] * 1.18
                and energies[i] >= energies[i + 1] and t - last >= 0.075):
            peaks.append(round(t, 3))
            last = t
    return peaks


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, manager):
        if address[0] != '127.0.0.1':
            raise ValueError('Loopback-only binding is mandatory.')
        self.manager = manager
        self.csrf = secrets.token_urlsafe(32)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = 'LocalStemCompanion/0.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *args):
        pass  # Do not log URLs, filenames or tokens.

    def guard(self, mutation=False):
        port = self.server.server_port
        host = self.headers.get('Host', '')
        if len(self.headers.get_all('Host', [])) != 1 or len(self.headers.get_all('Origin', [])) > 1:
            raise Problem('Duplicate or missing authority headers.')
        if host not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
            raise Problem('Invalid local Host header.')
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + host:
            raise Problem('Cross-origin access is not allowed.')
        if self.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'):
            raise Problem('Cross-site access is not allowed.')
        if mutation:
            if origin != 'http://' + host:
                raise Problem('Same-origin mutation required.')
            if not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), self.server.csrf):
                raise Problem('Invalid session token. Reload this local page.')
            if self.headers.get('Transfer-Encoding'):
                raise Problem('Chunked uploads are not supported.')

    def common_headers(self, content_type, length):
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()

    def json_response(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.common_headers('application/json; charset=utf-8', len(payload))
        self.wfile.write(payload)

    def body_length(self, maximum):
        try:
            if len(self.headers.get_all('Content-Length', [])) != 1:
                raise ValueError()
            length = int(self.headers['Content-Length'])
            if not 0 < length <= maximum:
                raise ValueError()
        except (ValueError, TypeError):
            raise Problem(f'Require one Content-Length between 1 and {maximum} bytes.') from None
        return length

    def read_json(self):
        if self.headers.get_content_type() != 'application/json':
            raise Problem('Expected application/json.')
        raw = self.rfile.read(self.body_length(8192))
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise Problem('Expected a JSON object.')
        return data

    def do_GET(self):
        try:
            self.guard()
            path = urlsplit(self.path).path
            if path == '/api/session':
                self.json_response({'csrf': self.server.csrf, 'dependencies': self.server.manager.config.dependencies(),
                    'limits': {'max_upload_bytes': MAX_UPLOAD, 'max_source_seconds': MAX_SOURCE_SECONDS,
                               'max_excerpt_seconds': MAX_EXCERPT_SECONDS}, 'job': self.server.manager.current()})
            elif re.fullmatch(r'/api/jobs/[a-f0-9]{32}', path):
                with self.server.manager.lock:
                    self.json_response(self.server.manager._get(path.rsplit('/', 1)[1]).public())
            elif re.fullmatch(r'/media/[a-f0-9]{32}/(vocals|bass|drums|other)\.wav', path):
                _, _, jid, filename = path.split('/')
                with self.server.manager.lock:
                    job = self.server.manager._get(jid)
                    if job.status != 'ready':
                        raise Problem('Audio is not ready.')
                    self.file_response(safe_child(job.directory, filename), 'audio/wav')
            elif path in ('/', '/index.html', '/app.js', '/style.css'):
                name = 'index.html' if path == '/' else path[1:]
                mime = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[name]
                self.file_response(STATIC / name, mime)
            else:
                self.json_response({'error': 'Not found.'}, 404)
        except (Problem, ValueError, OSError) as exc:
            self.json_response({'error': str(exc)}, 400)

    def file_response(self, path, mime):
        with path.open('rb') as stream:
            self.send_response(200)
            self.common_headers(mime, path.stat().st_size)
            shutil.copyfileobj(stream, self.wfile, 64 * 1024)

    def do_POST(self):
        try:
            self.guard(mutation=True)
            url = urlsplit(self.path)
            manager = self.server.manager
            if url.path == '/api/jobs':
                data = self.read_json()
                if set(data) - {'youtube_url', 'start_seconds', 'duration_seconds', 'rights_confirmed'}:
                    raise Problem('Unknown job option.')
                if not data.get('youtube_url'):
                    raise Problem('A single YouTube URL is required.')
                job = manager.reserve(data.get('start_seconds', 0), data.get('duration_seconds', 60), data.get('rights_confirmed'), data['youtube_url'])
                manager.start(job)
                self.json_response(job.public(), 202)
            elif url.path == '/api/upload':
                size = self.body_length(MAX_UPLOAD)
                q = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                if set(q) - {'start_seconds', 'duration_seconds', 'rights_confirmed'} or any(len(v) != 1 for v in q.values()):
                    raise Problem('Invalid upload options.')
                job = manager.reserve(q.get('start_seconds', ['0'])[0], q.get('duration_seconds', ['60'])[0], q.get('rights_confirmed') == ['1'])
                if job.status == 'dependency_missing':
                    self.close_connection = True
                    self.json_response(job.public(), 202)
                    return
                try:
                    with (job.directory / 'source.upload').open('xb') as target:
                        remaining = size
                        while remaining:
                            if job.cancel.is_set():
                                raise Cancelled('Upload cancelled.')
                            chunk = self.rfile.read(min(64 * 1024, remaining))
                            if not chunk:
                                raise Problem('Upload was interrupted.')
                            target.write(chunk)
                            remaining -= len(chunk)
                    manager.start(job)
                except Exception as exc:
                    with manager.lock:
                        job.status = 'cancelled' if isinstance(exc, Cancelled) else 'failed'
                        job.message, job.error = 'Upload stopped.', str(exc)
                    raise
                self.json_response(job.public(), 202)
            elif re.fullmatch(r'/api/jobs/[a-f0-9]{32}/cancel', url.path):
                self.json_response(manager.cancel_job(url.path.split('/')[3]))
            else:
                self.json_response({'error': 'Not found.'}, 404)
        except (Problem, ValueError, OSError) as exc:
            self.close_connection = True
            self.json_response({'error': str(exc)}, 400)

    def do_DELETE(self):
        try:
            self.guard(mutation=True)
            if not re.fullmatch(r'/api/jobs/[a-f0-9]{32}', self.path):
                raise Problem('Invalid job path.')
            self.server.manager.delete(self.path.rsplit('/', 1)[1])
            self.json_response({'deleted': True})
        except (Problem, ValueError, OSError) as exc:
            self.json_response({'error': str(exc)}, 400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--cache-dir', type=Path, default=Path.home() / '.cache' / 'music-stem-companion')
    model = parser.add_mutually_exclusive_group()
    model.add_argument('--allow-model-download', action='store_true', help='Explicitly permit Demucs to download its third-party model weights.')
    model.add_argument('--model-repo', type=Path, help='Existing trusted local Demucs repository containing htdemucs YAML and weights.')
    parser.add_argument('--device', choices=('cpu', 'cuda', 'mps'), default='cpu')
    parser.add_argument('--trust-env-proxy', action='store_true',
                        help='Explicitly trust and inherit existing HTTP(S)/ALL/NO_PROXY variables; never use to evade access restrictions.')
    parser.add_argument('--check', action='store_true', help='Print dependency presence and exit; does not import models or download anything.')
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error('Python 3.11 or later is required.')
    if not 1024 <= args.port <= 65535:
        parser.error('Use a port between 1024 and 65535.')
    config = Config(args.cache_dir.expanduser().resolve(), args.allow_model_download,
                    args.model_repo.expanduser().resolve() if args.model_repo else None, args.device, args.trust_env_proxy)
    if args.check:
        print(json.dumps(config.dependencies(), indent=2))
        return
    manager = Manager(config)
    server = Server(('127.0.0.1', args.port), manager)
    print(f'Open http://127.0.0.1:{args.port} — local only. Ctrl+C stops and clears this session.')
    print('No model is loaded until a job is submitted. Dependency check:', json.dumps(config.dependencies()))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        manager.close()


if __name__ == '__main__':
    main()
