"""Offline checks only: synthetic audio, mock acquisition/model; no remote requests."""
import array
import http.client
import io
import json
import math
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import companion as c

VIDEO = 'AbCdEf_12-3'
URL = f'https://www.youtube.com/watch?v={VIDEO}'
READY = {'ready': True, 'youtube_ready': True, 'missing': [], 'youtube_missing': [], 'versions': {}}


def write_wav(path, seconds=1, pulse=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 44100
    samples = array.array('h')
    for i in range(round(rate * seconds)):
        time = i / rate
        active = pulse and any(t <= time < t + 0.01 for t in (0.2, 0.5, 0.8))
        value = int(15000 * math.sin(i * 2 * math.pi * 200 / rate)) if active else 0
        samples.extend((value, value))
    if sys.byteorder != 'little':
        samples.byteswap()
    with wave.open(str(path), 'wb') as out:
        out.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        out.writeframes(samples.tobytes())


class Validators(unittest.TestCase):
    def test_youtube_allowed_canonical(self):
        for value in (URL, f'https://youtube.com/watch?v={VIDEO}&t=12',
                      f'https://m.youtube.com/watch?v={VIDEO}&feature=share',
                      f'https://youtu.be/{VIDEO}?si=sharing', f'https://www.youtube.com/shorts/{VIDEO}'):
            with self.subTest(value=value):
                self.assertEqual(c.youtube_url(value), URL)

    def test_youtube_rejected(self):
        for value in (None, '', 'http://youtu.be/' + VIDEO, 'https://127.0.0.1/watch?v=' + VIDEO,
                      'https://youtube.com.evil.test/watch?v=' + VIDEO,
                      'https://evil.test/?url=' + URL, 'https://user@youtube.com/watch?v=' + VIDEO,
                      URL + '&list=playlist', URL + '&v=' + VIDEO, URL + '#fragment',
                      'https://youtube.com:443/watch?v=' + VIDEO, URL + '&url=https://127.0.0.1',
                      'https://youtu.be/' + VIDEO + '/extra', 'https://youtu.be/%2e%2e%2fprivate',
                      'https://youtube.com/live/' + VIDEO, URL + '\n', URL + '&novalue',
                      'https://youtu.be/short', 'https://youtube.com/playlist?list=abc'):
            with self.subTest(value=value):
                self.assertRaises(c.Problem, c.youtube_url, value)

    def test_excerpt_bounds(self):
        self.assertEqual(c.excerpt('0', '3600'), (0.0, 3600.0))
        self.assertEqual(c.excerpt(3599, 1), (3599.0, 1.0))
        self.assertEqual(c.excerpt(0, 'full'), (0.0, None))
        for start, length in ((-1, 1), (3600, 1), (0, 0.99), (0, 3601), (1, 'full'), (float('nan'), 10),
                              (0, float('inf')), (True, 5), (0, False), ('bad', 2)):
            with self.subTest(start=start, length=length):
                self.assertRaises(c.Problem, c.excerpt, start, length)

    def test_metadata_public_video(self):
        self.assertEqual(c.validate_youtube_metadata({'duration': 40, 'availability': 'public'}), 40)

    def test_metadata_restrictions(self):
        for overrides in ({'_type': 'playlist'}, {'entries': [1]}, {'is_live': True},
                          {'live_status': 'is_upcoming'}, {'has_drm': True}, {'age_limit': 18},
                          {'availability': 'private'}, {'availability': 'subscriber_only'},
                          {'duration': 3601}, {'duration': float('nan')}, {'duration': 0},
                          {'filesize': c.MAX_UPLOAD + 1}, {'filesize': -1},
                          {'filesize': float('nan')}, {'filesize': float('inf')}):
            with self.subTest(overrides=overrides):
                self.assertRaises(c.Problem, c.validate_youtube_metadata, {'duration': 20, 'availability': 'public', **overrides})
        self.assertRaises(c.Problem, c.validate_youtube_metadata, {})

    def test_long_model_windows_cover_the_song_with_overlap(self):
        for duration in (1, 50, 51, 90, 204, 3600):
            windows = c.model_windows(duration)
            self.assertEqual(windows[0][0], 0)
            self.assertAlmostEqual(windows[-1][0] + windows[-1][1], duration)
            for left, right in zip(windows, windows[1:]):
                self.assertAlmostEqual(left[0] + left[1] - right[0], c.MODEL_OVERLAP_SECONDS)
                self.assertGreater(right[1], c.MODEL_OVERLAP_SECONDS)

    def test_safe_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            root.mkdir()
            self.assertEqual(c.safe_child(root, 'sub', 'song.wav'), root / 'sub' / 'song.wav')
            for parts in (('..', 'outside'), ('/etc/passwd',), ('.',)):
                self.assertRaises(c.Problem, c.safe_child, root, *parts)

    def test_safe_paths_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            root.mkdir()
            try:
                (root / 'link').symlink_to(Path(tmp), target_is_directory=True)
            except OSError as exc:
                if getattr(exc, 'winerror', None) == 1314:
                    self.skipTest('Windows user lacks permission to create symbolic links')
                raise
            self.assertRaises(c.Problem, c.safe_child, root, 'link', 'outside')


class Dependencies(unittest.TestCase):
    def test_core_runtime_metadata_required_without_importing_models(self):
        for absent in ('demucs', 'torch', 'numpy'):
            with self.subTest(absent=absent), tempfile.TemporaryDirectory() as tmp:
                with patch.object(c, 'package_version', side_effect=lambda name: None if name == absent else 'test-version'), \
                     patch.object(c.shutil, 'which', side_effect=lambda name: '/tools/' + name):
                    deps = c.Config(Path(tmp), allow_model_download=True).dependencies()
                self.assertFalse(deps['ready'])
                self.assertFalse(deps['youtube_ready'])
                self.assertEqual(deps['missing'], [absent])

    def test_core_runtime_present_can_be_ready_without_youtube_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(c, 'package_version', side_effect=lambda name: 'test-version' if name in ('demucs', 'torch', 'numpy') else None), \
                 patch.object(c.shutil, 'which', side_effect=lambda name: None if name == 'deno' else '/tools/' + name):
                deps = c.Config(Path(tmp), allow_model_download=True).dependencies()
            self.assertTrue(deps['ready'])
            self.assertFalse(deps['youtube_ready'])
            self.assertEqual(deps['missing'], [])
            self.assertEqual(deps['youtube_missing'], ['yt-dlp', 'yt-dlp-ejs', 'deno'])


class ManagerChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = c.Config(Path(self.temp.name), True)
        self.deps = patch.object(c.Config, 'dependencies', return_value=READY)
        self.deps.start()
        self.manager = c.Manager(self.config)

    def tearDown(self):
        self.manager.close()
        self.deps.stop()
        self.temp.cleanup()

    def test_requires_rights(self):
        for rights in (False, None, 1, 'yes'):
            self.assertRaises(c.Problem, self.manager.reserve, 0, 60, rights)

    def test_single_job_and_delete(self):
        job = self.manager.reserve(0, 60, True)
        self.assertEqual(job.status, 'queued')
        self.assertEqual(self.manager.current()['id'], job.id)
        self.assertRaises(c.Problem, self.manager.reserve, 0, 60, True)
        self.assertRaises(c.Problem, self.manager.delete, job.id)
        job.status = 'failed'
        self.manager.delete(job.id)
        self.assertIsNone(self.manager.current())
        self.assertFalse(job.directory.exists())
        self.assertEqual(self.manager.reserve(0, 60, True).status, 'queued')

    def test_dependency_missing_is_explicit(self):
        with patch.object(c.Config, 'dependencies', return_value={**READY, 'missing': ['demucs']}):
            job = self.manager.reserve(0, 60, True)
        self.assertEqual(job.status, 'dependency_missing')
        self.assertIn('demucs', job.error)
        self.manager.start(job)
        self.assertIsNone(self.manager.worker)

    def test_youtube_only_dependency_does_not_block_file(self):
        with patch.object(c.Config, 'dependencies', return_value={**READY, 'youtube_missing': ['deno']}):
            job = self.manager.reserve(0, 60, True)
            self.assertEqual(job.status, 'queued')
            job.status = 'failed'
            self.manager.delete(job.id)
            youtube = self.manager.reserve(0, 60, True, URL)
            self.assertEqual(youtube.status, 'dependency_missing')

    def test_cancellation_and_job_lookup(self):
        job = self.manager.reserve(0, 60, True)
        self.assertRaises(c.Problem, self.manager.cancel_job, '../bad')
        state = self.manager.cancel_job(job.id)
        self.assertTrue(job.cancel.is_set())
        self.assertIn('Cancellation', state['message'])
        self.assertRaises(c.Cancelled, self.manager.stage, job, 'normalizing', 'message')

    def test_environment_does_not_inherit_secrets_or_proxies(self):
        with patch.dict('os.environ', {'HTTPS_PROXY': 'secret', 'HF_TOKEN': 'secret', 'PYTHONPATH': 'secret'}):
            env = self.manager.environment()
        self.assertNotIn('HTTPS_PROXY', env)
        self.assertNotIn('HF_TOKEN', env)
        self.assertNotIn('PYTHONPATH', env)
        self.assertTrue(env['HF_HOME'].startswith(self.temp.name))

    def test_model_download_policy_is_explicit_and_offline_by_default(self):
        self.config.allow_model_download = False
        self.config.model_repo = Path(self.temp.name) / 'trusted-models'
        self.config.model_repo.mkdir()
        env = self.manager.environment()
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')
        self.assertEqual(env['TRANSFORMERS_OFFLINE'], '1')
        self.assertEqual(env['HF_HUB_DISABLE_IMPLICIT_TOKEN'], '1')
        self.assertNotIn('HTTPS_PROXY', env)
        self.config.allow_model_download = True
        env = self.manager.environment()
        self.assertNotIn('HF_HUB_OFFLINE', env)
        self.assertNotIn('TRANSFORMERS_OFFLINE', env)

    def test_explicit_trusted_proxy_inherits_only_proxy_allowlist(self):
        self.config.trust_env_proxy = True
        allowed = {'HTTPS_PROXY': 'http://approved-egress.invalid:8080',
                   'https_proxy': 'http://approved-egress.invalid:8080',
                   'NO_PROXY': 'localhost,127.0.0.1'}
        forbidden = {'HF_TOKEN': 'secret', 'PYTHONPATH': 'secret', 'PIP_PROXY': 'unrelated',
                     'AWS_SECRET_ACCESS_KEY': 'secret', 'SSL_CERT_FILE': '/untrusted/cert'}
        with patch.dict('os.environ', {**allowed, **forbidden}, clear=True):
            env = self.manager.environment()
        for key, value in allowed.items():
            self.assertEqual(env[key], value)
        for key in forbidden:
            self.assertNotIn(key, env)
        self.assertEqual(env['HF_HUB_DISABLE_IMPLICIT_TOKEN'], '1')

    def test_explicit_trusted_proxy_does_not_override_downloader_route(self):
        self.config.trust_env_proxy = True
        args = self.manager.ytdlp_args()
        self.assertNotIn('--proxy', args)
        self.assertIn('--ignore-config', args)
        self.assertIn('--no-plugin-dirs', args)
        self.assertIn('--no-remote-components', args)
        self.assertNotIn('--cookies', args)

    def test_model_repo_is_passed_to_fixed_demucs_name_without_network_fallback(self):
        self.config.allow_model_download = False
        self.config.model_repo = Path(self.temp.name) / 'trusted-models'
        self.config.model_repo.mkdir()
        job = self.manager.reserve(0, 1, True)
        write_wav(job.directory / 'source.upload')
        commands = []
        def fake_run(job_arg, args, **kwargs):
            commands.append(args)
            if args[0] == 'ffprobe':
                return json.dumps({'format': {'duration': 1}, 'streams': [{'codec_type': 'audio', 'channels': 2, 'sample_rate': 44100}]})
            if 'demucs' in args:
                raise c.Problem('Stop before loading any local model.')
            write_wav(Path(args[-1]))
            return ''
        with patch.object(self.manager, 'run', side_effect=fake_run):
            self.manager._work(job)
        command = next(args for args in commands if 'demucs' in args)
        self.assertEqual(command[command.index('-n') + 1], 'htdemucs')
        self.assertEqual(command[command.index('--repo') + 1], str(self.config.model_repo.resolve()))
        self.assertEqual(job.status, 'failed')

    def test_downloader_has_no_user_config(self):
        args = self.manager.ytdlp_args()
        self.assertIn('--ignore-config', args)
        self.assertIn('--no-playlist', args)
        self.assertIn('--no-remote-components', args)
        self.assertEqual(args[args.index('--xff') + 1], 'never')
        self.assertNotIn('--netrc', args)
        self.assertEqual(args[args.index('--proxy') + 1], '')
        self.assertNotIn('--cookies', args)
        self.assertNotIn('--cookies-from-browser', args)

    def test_real_subprocess_runner_uses_only_synthetic_command(self):
        job = self.manager.reserve(0, 1, True)
        self.assertEqual(self.manager.run(job, [sys.executable, '-c', 'print("synthetic-runner-check")']).strip(), 'synthetic-runner-check')
        self.assertIsNone(job.process)

    def test_real_subprocess_timeout_stops_process(self):
        job = self.manager.reserve(0, 1, True)
        with self.assertRaisesRegex(c.Problem, 'exceeded'):
            self.manager.run(job, [sys.executable, '-c', 'import time; time.sleep(10)'], timeout=0.01)
        self.assertIsNone(job.process)

    def test_real_subprocess_cancellation(self):
        job = self.manager.reserve(0, 1, True)
        timer = threading.Timer(0.1, job.cancel.set)
        timer.start()
        try:
            self.assertRaises(c.Cancelled, self.manager.run, job,
                              [sys.executable, '-c', 'import time; time.sleep(10)'])
            self.assertIsNone(job.process)
        finally:
            timer.cancel()

    def test_real_subprocess_output_cap(self):
        job = self.manager.reserve(0, 1, True)
        with self.assertRaisesRegex(c.Problem, 'output exceeded'):
            self.manager.run(job, [sys.executable, '-c', 'print("x" * 1000)'], output_limit=100)
        self.assertIsNone(job.process)

    def test_real_subprocess_nonzero_error_is_explicit(self):
        job = self.manager.reserve(0, 1, True)
        with self.assertRaisesRegex(c.Problem, 'Synthetic command failure'):
            self.manager.run(job, [sys.executable, '-c', 'import sys; print("Synthetic command failure", file=sys.stderr); sys.exit(7)'])

    def test_mocked_public_youtube_acquisition(self):
        job = self.manager.reserve(0, 1, True, URL)
        commands = []
        def fake_run(job_arg, args, **kwargs):
            commands.append(args)
            if '--skip-download' in args:
                return json.dumps({'id': VIDEO, 'duration': 20, 'availability': 'public'})
            write_wav(job.directory / 'source.m4a')
            return ''
        with patch.object(self.manager, 'run', side_effect=fake_run):
            result = self.manager.acquire(job)
        self.assertTrue(result.exists())
        self.assertEqual(len(commands), 2)
        self.assertIn('--max-filesize', commands[-1])
        self.assertEqual(commands[-1][-1], URL)

    def test_restricted_youtube_stops_before_acquisition(self):
        job = self.manager.reserve(0, 1, True, URL)
        with patch.object(self.manager, 'run', return_value=json.dumps({'id': VIDEO, 'duration': 20, 'availability': 'private'})) as run:
            self.assertRaises(c.Problem, self.manager.acquire, job)
        self.assertEqual(run.call_count, 1)

    def test_wrong_youtube_identity_stops_before_acquisition(self):
        job = self.manager.reserve(0, 1, True, URL)
        with patch.object(self.manager, 'run', return_value=json.dumps({'id': 'OtherID_123', 'duration': 20, 'availability': 'public'})) as run:
            self.assertRaises(c.Problem, self.manager.acquire, job)
        self.assertEqual(run.call_count, 1)

    def test_empty_upload_fails_without_tool_run(self):
        job = self.manager.reserve(0, 1, True)
        with patch.object(self.manager, 'run') as run:
            self.manager._work(job)
        self.assertEqual(job.status, 'failed')
        run.assert_not_called()

    def test_cancelled_worker_never_invokes_subprocess(self):
        job = self.manager.reserve(0, 1, True)
        (job.directory / 'source.upload').write_bytes(b'synthetic placeholder')
        job.cancel.set()
        with patch.object(self.manager, 'run') as run:
            self.manager._work(job)
        self.assertEqual(job.status, 'cancelled')
        run.assert_not_called()

    def test_mocked_pipeline_produces_four_aligned_stems(self):
        job = self.manager.reserve(0, 1, True)
        write_wav(job.directory / 'source.upload', pulse=True)
        commands = []
        def fake_run(job_arg, args, **kwargs):
            commands.append(args)
            if args[0] == 'ffprobe':
                return json.dumps({'format': {'duration': 1}, 'streams': [{'codec_type': 'audio', 'channels': 2, 'sample_rate': '44100'}]})
            if 'demucs' in args:
                for name in c.STEMS:
                    write_wav(job.directory / 'separated' / 'htdemucs' / 'excerpt' / f'{name}.wav', pulse=name == 'drums')
            else:
                shutil.copyfile(Path(args[args.index('-i') + 1]), Path(args[-1]))
            return ''
        with patch.object(self.manager, 'run', side_effect=fake_run), patch.object(c, 'float_wav_peak', return_value=0.5):
            self.manager._work(job)
        self.assertEqual(job.status, 'ready', job.error)
        self.assertEqual(set(job.public()['stems']), set(c.STEMS))
        self.assertEqual(job.duration, 1)
        self.assertGreaterEqual(len(job.onsets), 2)
        self.assertEqual({p.name for p in job.directory.iterdir()}, {n + '.wav' for n in c.STEMS})
        self.assertTrue(any('demucs' in args for args in commands))
        model_command = next(args for args in commands if 'demucs' in args)
        self.assertIn('--float32', model_command)
        self.assertEqual(model_command[model_command.index('--clip-mode') + 1], 'none')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'Optional synthetic FFmpeg integration: ffmpeg/ffprobe unavailable')
    def test_synthetic_ffmpeg_pipeline_with_mocked_model_only(self):
        job = self.manager.reserve(0, 1, True)
        write_wav(job.directory / 'source.upload', pulse=True)
        real_run = self.manager.run
        commands = []
        def model_only_mock(job_arg, args, **kwargs):
            commands.append(args)
            if 'demucs' in args:
                dest = job.directory / 'separated' / 'htdemucs' / 'excerpt'
                dest.mkdir(parents=True)
                for name in c.STEMS:
                    shutil.copyfile(job.directory / 'excerpt.wav', dest / (name + '.wav'))
                return ''
            return real_run(job_arg, args, **kwargs)
        with patch.object(self.manager, 'run', side_effect=model_only_mock), patch.object(c, 'float_wav_peak', return_value=1.96):
            self.manager._work(job)
        self.assertEqual(job.status, 'ready', job.error)
        self.assertAlmostEqual(job.duration, 1, places=3)
        self.assertAlmostEqual(job.output_gain, 0.5)
        with wave.open(str(job.directory / 'drums.wav'), 'rb') as wav:
            samples = array.array('h', wav.readframes(wav.getnframes()))
            self.assertTrue(7400 <= max(samples) <= 7600)
        self.assertEqual(len(job.onsets), 3)
        self.assertTrue(any(args[0] == 'ffprobe' for args in commands))
        self.assertEqual(sum(args[0] == 'ffmpeg' for args in commands), 5)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg unavailable')
    def test_full_song_crossfades_multiple_model_pieces_without_losing_time(self):
        job = self.manager.reserve(0, 'full', True)
        source = job.directory / 'source.upload'
        import subprocess
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=51',
                        '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 'wav', str(source)], check=True)
        with wave.open(str(source), 'rb') as wav:
            wav.setpos(round(44.5 * 44100))
            reference = array.array('h', wav.readframes(44100))
        real_run = self.manager.run
        def model_only_mock(job_arg, args, **kwargs):
            if 'demucs' in args:
                for track in (Path(item) for item in args if str(item).endswith('.wav')):
                    dest = job.directory / 'separated' / 'htdemucs' / track.stem
                    dest.mkdir(parents=True)
                    for name in c.STEMS:
                        shutil.copyfile(track, dest / (name + '.wav'))
                return ''
            return real_run(job_arg, args, **kwargs)
        with patch.object(self.manager, 'run', side_effect=model_only_mock), patch.object(c, 'float_wav_peak', return_value=0.5):
            self.manager._work(job)
        self.assertEqual(job.status, 'ready', job.error)
        self.assertAlmostEqual(job.duration, 51, places=2)
        with wave.open(str(job.directory / 'drums.wav'), 'rb') as wav:
            self.assertEqual(wav.getnframes(), 51 * 44100)
            wav.setpos(round(44.5 * 44100))
            joined = array.array('h', wav.readframes(44100))
        error = math.sqrt(sum((a - b) ** 2 for a, b in zip(reference, joined)) / len(reference))
        signal = math.sqrt(sum(a * a for a in reference) / len(reference))
        self.assertLess(error / signal, 0.01)

    def test_model_error_stops_pipeline(self):
        job = self.manager.reserve(0, 1, True)
        write_wav(job.directory / 'source.upload')
        with patch.object(self.manager, 'run', side_effect=c.Problem('Synthetic model failure')):
            self.manager._work(job)
        self.assertEqual(job.status, 'failed')
        self.assertIn('Synthetic model failure', job.error)


class AudioChecks(unittest.TestCase):
    def test_float_wav_peak_preserves_over_range_values_and_rejects_nan(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'float.wav'
            def write(values):
                data = struct.pack('<' + 'f' * len(values), *values)
                header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(data), b'WAVE', b'fmt ', 16,
                                     3, 2, 44100, 44100 * 8, 8, 32, b'data', len(data))
                path.write_bytes(header + data)
            write([0.25, -1.4, 0.5, 0.0])
            self.assertAlmostEqual(c.float_wav_peak(path), 1.4, places=5)
            event = threading.Event(); event.set()
            self.assertRaises(c.Cancelled, c.float_wav_peak, path, event)
            write([0.1, float('nan')])
            self.assertRaises(c.Problem, c.float_wav_peak, path)

    def test_silence_and_synthetic_pulses(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.wav'
            write_wav(path)
            self.assertEqual(c.detect_onsets(path), [])
            write_wav(path, pulse=True)
            detected = c.detect_onsets(path)
            self.assertEqual(len(detected), 3)
            for actual, expected in zip(detected, (0.2, 0.5, 0.8)):
                self.assertAlmostEqual(actual, expected, delta=0.02)

    def test_detector_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.wav'
            write_wav(path)
            event = threading.Event()
            event.set()
            self.assertRaises(c.Cancelled, c.detect_onsets, path, event)


class HTTPChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.manager = c.Manager(c.Config(Path(cls.temp.name), True))
        cls.deps = patch.object(c.Config, 'dependencies', return_value=READY)
        cls.deps.start()
        cls.server = c.Server(('127.0.0.1', 0), cls.manager)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host = f'127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)
        cls.manager.close()
        cls.deps.stop()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        merged = {'Host': self.host, **(headers or {})}
        conn.request(method, path, body=body, headers=merged)
        response = conn.getresponse()
        data = response.read()
        status, result_headers = response.status, dict(response.getheaders())
        conn.close()
        return status, result_headers, json.loads(data) if result_headers.get('Content-Type', '').startswith('application/json') else data

    def test_local_session_has_token_and_security_headers(self):
        status, headers, data = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        self.assertEqual(data['csrf'], self.server.csrf)
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])

    def test_youtube_preview_has_a_separate_origin_without_api_access(self):
        preview_host = f'localhost:{self.server.server_port}'
        status, headers, _ = self.request('GET', '/youtube-preview.html', headers={'Host': preview_host})
        self.assertEqual(status, 200)
        self.assertNotIn('X-Frame-Options', headers)
        self.assertIn('frame-ancestors http://' + self.host, headers['Content-Security-Policy'])
        self.assertEqual(self.request('GET', '/youtube-preview.html')[0], 404)
        self.assertEqual(self.request('GET', '/api/session', headers={'Host': preview_host})[0], 404)
        headers = {'Host': preview_host, 'Origin': 'http://' + preview_host, 'X-CSRF-Token': self.server.csrf,
                   'Content-Type': 'application/json'}
        self.assertEqual(self.request('POST', '/api/jobs', '{}', headers)[0], 400)

    def test_ready_stems_are_served_as_bounded_wav_chunks(self):
        job = self.manager.reserve(0, 1, True)
        write_wav(job.directory / 'drums.wav', pulse=True)
        job.status, job.duration = 'ready', 1
        status, headers, data = self.request('GET', f'/media/{job.id}/chunks/0/drums.wav')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'audio/wav')
        with wave.open(io.BytesIO(data), 'rb') as wav:
            self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getnframes()), (2, 44100, 44100))
        self.assertEqual(self.request('GET', f'/media/{job.id}/chunks/1/drums.wav')[0], 400)
        self.manager.delete(job.id)

    def test_bundled_song_works_without_separation_tools_and_cannot_be_deleted(self):
        missing = {'ready': False, 'youtube_ready': False, 'missing': ['demucs'], 'youtube_missing': []}
        with patch.object(c.Config, 'dependencies', return_value=missing):
            status, _, session = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        demo = session['bundled_demo']
        self.assertFalse(session['dependencies']['ready'])
        self.assertEqual(demo['id'], c.DEMO_ID)
        self.assertAlmostEqual(demo['duration'], 204.3356, places=3)
        self.assertEqual(len(demo['onsets']), 262)
        for index, frames in ((0, 20 * 44100), (10, round((demo['duration'] - 200) * 44100))):
            status, headers, data = self.request('GET', f'/media/{c.DEMO_ID}/chunks/{index}/drums.wav')
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], 'audio/wav')
            with wave.open(io.BytesIO(data), 'rb') as wav:
                self.assertEqual(wav.getnframes(), frames)
        self.assertEqual(self.request('GET', f'/media/{c.DEMO_ID}/chunks/11/drums.wav')[0], 400)
        self.assertEqual(self.request('GET', f'/media/{c.DEMO_ID}/chunks/0/drums.wav',
                                      headers={'Host': f'localhost:{self.server.server_port}'})[0], 404)
        headers = {'Origin': 'http://' + self.host, 'X-CSRF-Token': self.server.csrf}
        self.assertEqual(self.request('DELETE', '/api/jobs/' + c.DEMO_ID, headers=headers)[0], 400)
        self.assertTrue((c.BUNDLED_DEMO / 'drums.wav').is_file())

    def test_drum_samples_are_local_and_not_available_from_preview_origin(self):
        for name in ('kick.m4a', 'snare.m4a', 'tom.flac', 'hat.m4a', 'open-hat.m4a', 'crash.m4a'):
            status, headers, data = self.request('GET', '/samples/' + name)
            self.assertEqual(status, 200)
            self.assertTrue(headers['Content-Type'].startswith('audio/'))
            self.assertGreater(len(data), 1000)
            self.assertEqual(self.request('GET', '/samples/' + name, headers={'Host': f'localhost:{self.server.server_port}'})[0], 404)

    def test_invalid_host_origin_and_site_are_rejected(self):
        for headers in ({'Host': 'evil.test'}, {'Origin': 'https://evil.test'},
                        {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request('GET', '/api/session', headers=headers)[0], 400)

    def test_mutations_require_origin_and_csrf(self):
        for headers in ({}, {'Origin': 'http://' + self.host}, {'X-CSRF-Token': self.server.csrf},
                        {'Origin': 'http://' + self.host, 'X-CSRF-Token': 'bad'}):
            with self.subTest(headers=headers):
                status, _, _ = self.request('POST', '/api/jobs', '{}', {'Content-Type': 'application/json', **headers})
                self.assertEqual(status, 400)

    def test_unsafe_routes_are_not_filesystem_access(self):
        for path in ('/companion.py', '/../../etc/passwd', '/media/../../etc/passwd', '/%2e%2e/etc/passwd'):
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 404)

    def test_json_body_size_cap(self):
        headers = {'Origin': 'http://' + self.host, 'X-CSRF-Token': self.server.csrf, 'Content-Type': 'application/json'}
        self.assertEqual(self.request('POST', '/api/jobs', 'x' * 8193, headers)[0], 400)

    def test_upload_size_cap(self):
        headers = {'Origin': 'http://' + self.host, 'X-CSRF-Token': self.server.csrf,
                   'Content-Length': str(c.MAX_UPLOAD + 1)}
        self.assertEqual(self.request('POST', '/api/upload', None, headers)[0], 400)

    def test_job_creation_status_and_deletion(self):
        headers = {'Origin': 'http://' + self.host, 'X-CSRF-Token': self.server.csrf, 'Content-Type': 'application/json'}
        with patch.object(c.Config, 'dependencies', return_value={**READY, 'missing': ['synthetic-missing-demucs']}):
            status, _, data = self.request('POST', '/api/jobs', json.dumps({'youtube_url': URL, 'rights_confirmed': True}), headers)
        self.assertEqual(status, 202)
        self.assertEqual(data['status'], 'dependency_missing')
        jid = data['id']
        self.assertEqual(self.request('GET', '/api/jobs/' + jid)[2]['status'], 'dependency_missing')
        self.assertEqual(self.request('GET', f'/media/{jid}/drums.wav')[0], 400)
        self.assertEqual(self.request('DELETE', '/api/jobs/' + jid, headers=headers)[0], 200)
        self.assertEqual(self.request('GET', '/api/jobs/' + jid)[0], 400)

    def test_loopback_binding_is_mandatory(self):
        self.assertRaises(ValueError, c.Server, ('0.0.0.0', 0), self.manager)


if __name__ == '__main__':
    unittest.main()
