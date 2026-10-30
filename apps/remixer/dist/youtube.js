const API_URL = 'https://www.youtube.com/iframe_api';
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
let apiPromise = null;

export function parseYouTubeUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  let url;
  try { url = new URL(text); } catch { throw new Error('YouTube 영상의 전체 링크를 넣어 주세요. 예: https://www.youtube.com/watch?v=…'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('공식 YouTube 영상 링크만 사용할 수 있어요.');
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    if (parts.length === 1) id = parts[0];
  } else if (HOSTS.has(host)) {
    if (url.pathname === '/watch' || url.pathname === '/watch/') id = url.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'embed', 'live'].includes(parts[0])) id = parts[1];
  } else if (host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com') {
    if (parts.length === 2 && parts[0] === 'embed') id = parts[1];
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error('영상 하나의 YouTube 링크를 확인해 주세요. 재생목록이나 채널 링크는 사용할 수 없어요.');
  return id;
}

// No script, iframe, request, or YouTube cookie is created before load()/ensure().
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let settled = false;
    const script = document.createElement('script');
    script.id = 'remixer-youtube-api'; script.src = API_URL; script.async = true;
    const cleanup = () => { clearTimeout(timeout); script.onerror = null; if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous; };
    const fail = () => {
      if (settled) return;
      settled = true; cleanup(); script.remove(); apiPromise = null;
      reject(new Error('YouTube 플레이어를 불러오지 못했어요. 연결이나 콘텐츠 차단 설정을 확인한 뒤 다시 눌러 주세요.'));
    };
    const ready = () => {
      if (settled) return;
      if (!window.YT?.Player) { fail(); return; }
      settled = true; cleanup(); resolve(window.YT);
      if (typeof previous === 'function') { try { previous(); } catch {} }
    };
    const timeout = setTimeout(fail, 15000);
    window.onYouTubeIframeAPIReady = ready;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return apiPromise;
}

function videoError(code) {
  const messages = {
    2: 'YouTube 영상 링크가 올바르지 않아요. 다른 영상 링크를 넣어 주세요.',
    5: '이 브라우저에서 영상을 재생하지 못했어요. YouTube에서 열거나 다른 영상을 골라 주세요.',
    100: '삭제되었거나 비공개인 영상이에요. 다른 영상을 골라 주세요.',
    101: '이 영상은 외부 사이트 재생이 허용되지 않아요. 다른 영상을 골라 주세요.',
    150: '이 영상은 외부 사이트 재생이 허용되지 않아요. 다른 영상을 골라 주세요.',
    153: 'YouTube가 이 사이트의 재생 정보를 확인하지 못했어요. YouTube에서 열거나 다른 브라우저를 사용해 주세요.',
  };
  const error = new Error(messages[code] || 'YouTube 영상을 재생하지 못했어요. 다른 영상 링크를 넣어 주세요.');
  error.code = code;
  return error;
}

export class YouTubeDeck {
  constructor({ elementId = 'youtube-player', onState = () => {}, onError = () => {}, onReady = () => {} } = {}) {
    this.elementId = elementId; this.onState = onState; this.onError = onError; this.onReady = onReady;
    this.player = null; this.ready = false; this.videoId = null; this._state = -1;
    this._pending = null; this._request = 0; this._destroyed = false; this._volume = .65;
    this._readyTimer = null; this._rejectReady = null; this._playerGeneration = 0;
  }
  get position() { const value = this.ready ? this.player?.getCurrentTime?.() : 0; return Number.isFinite(value) ? Math.max(0, value) : 0; }
  get duration() { const value = this.ready ? this.player?.getDuration?.() : 0; return Number.isFinite(value) ? Math.max(0, value) : 0; }
  get playing() { return this.ready && this._state === 1; }
  get title() { return this.ready ? this.player?.getVideoData?.()?.title || 'YouTube 영상' : 'YouTube 영상'; }

  async ensure() {
    if (this._destroyed) throw new Error('YouTube 플레이어가 닫혔어요. 페이지를 다시 열어 주세요.');
    if (this.ready) return this.player;
    if (this._pending) return this._pending;
    this._pending = this._createPlayer();
    try { return await this._pending; }
    catch (error) { this._pending = null; throw error; }
  }

  async _createPlayer() {
    const YT = await loadYouTubeAPI();
    if (this._destroyed) throw new Error('YouTube 플레이어가 닫혔어요.');
    const mount = document.getElementById(this.elementId);
    if (!mount) throw new Error('YouTube 플레이어 표시 영역을 찾지 못했어요. 페이지를 새로 열어 주세요.');
    const mountParent = mount.parentNode;
    const generation = ++this._playerGeneration;
    return new Promise((resolve, reject) => {
      const restoreMount = () => {
        if (mountParent && !document.getElementById(this.elementId)) { const replacement = document.createElement('div'); replacement.id = this.elementId; mountParent.appendChild(replacement); }
      };
      this._rejectReady = reject;
      this._readyTimer = setTimeout(() => {
        this._readyTimer = null; this._rejectReady = null; ++this._playerGeneration;
        try { this.player?.destroy(); } catch {}
        this.player = null; restoreMount();
        reject(new Error('YouTube 플레이어 준비가 오래 걸려요. 연결이나 콘텐츠 차단 설정을 확인해 주세요.'));
      }, 15000);
      const origin = window.location?.origin || globalThis.location?.origin;
      try { this.player = new YT.Player(this.elementId, {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 1, playsinline: 1, rel: 0, enablejsapi: 1, ...(origin && origin !== 'null' ? { origin } : {}) },
        events: {
          onReady: event => {
            if (this._destroyed || generation !== this._playerGeneration) return;
            clearTimeout(this._readyTimer); this._readyTimer = null; this._rejectReady = null;
            this.player = event.target; this.ready = true;
            this.player.setVolume(Math.round(this._volume * 100));
            resolve(this.player); this.onReady(this);
          },
          onStateChange: event => {
            if (this._destroyed || generation !== this._playerGeneration) return;
            this._state = event.data;
            this.onState(event.data);
          },
          onError: event => { if (!this._destroyed && generation === this._playerGeneration) { this._state = -1; this.onError(videoError(event.data)); } },
          onAutoplayBlocked: () => { if (!this._destroyed && generation === this._playerGeneration) this.onError(new Error('영상 안의 재생 버튼을 직접 눌러 시작해 주세요.')); },
        },
      }); } catch (error) {
        clearTimeout(this._readyTimer); this._readyTimer = null; this._rejectReady = null; ++this._playerGeneration; restoreMount(); reject(error);
      }
    });
  }

  async load(url) {
    const id = parseYouTubeUrl(url); // Validate before any external request.
    const request = ++this._request;
    this.pause();
    const player = await this.ensure();
    if (request !== this._request || this._destroyed) return null;
    this.videoId = id; this._state = 5;
    player.cueVideoById({ videoId: id, startSeconds: 0 });
    return { id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  play() { if (this.ready && !this._destroyed && this.videoId) this.player.playVideo(); }
  pause() { if (this.ready && !this._destroyed) { this.player.pauseVideo(); this._state = 2; } }
  stop() { ++this._request; if (this.ready && !this._destroyed) { this.player.stopVideo(); this._state = -1; } }
  seek(seconds) { const n = Number(seconds); if (this.ready && !this._destroyed && Number.isFinite(n)) this.player.seekTo(Math.max(0, this.duration ? Math.min(n, this.duration) : n), true); }
  volume(value) { const n = Number(value); if (!Number.isFinite(n)) return; this._volume = Math.min(1, Math.max(0, n)); if (this.ready && !this._destroyed) this.player.setVolume(Math.round(this._volume * 100)); }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true; ++this._request; this.ready = false; this._state = -1;
    clearTimeout(this._readyTimer); this._readyTimer = null;
    if (this._rejectReady) this._rejectReady(new Error('YouTube 플레이어가 닫혔어요.'));
    this._rejectReady = null;
    try { this.player?.destroy(); } catch {}
    this.player = null;
  }
}
