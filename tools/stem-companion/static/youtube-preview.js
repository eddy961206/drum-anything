'use strict';
// This page is served only from localhost. The main app and its API use 127.0.0.1.
const parentOrigin = `http://127.0.0.1:${location.port}`;
const statusText = document.getElementById('status');
let player = null, ready = false, pending = null, apiPromise = null, readyTimer = null;

function send(type, details = {}) {
  window.parent.postMessage({ type, ...details }, parentOrigin);
}

function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    const timer = setTimeout(() => fail(), 15000);
    const fail = () => { clearTimeout(timer); script.remove(); apiPromise = null; reject(new Error('YouTube 플레이어 연결에 실패했어요.')); };
    script.onerror = fail;
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    document.head.append(script);
  });
  return apiPromise;
}

function publish() {
  if (!ready || !pending) return;
  const loaded = player.getVideoData?.()?.video_id;
  if (loaded && loaded !== pending.id) return;
  const time = Number(player.getCurrentTime?.()) || 0;
  const duration = Number(player.getDuration?.()) || 0;
  send('state', { request: pending.request, id: pending.id, time, duration });
}

async function loadVideo(value) {
  pending = value;
  try {
    const YT = await loadApi();
    if (pending !== value) return;
    if (!player) {
      player = new YT.Player('player', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: event => {
            clearTimeout(readyTimer); player = event.target; ready = true;
            if (pending) { player.cueVideoById({ videoId: pending.id }); send('player-ready', { request: pending.request }); }
          },
          onStateChange: () => { statusText.textContent = ''; publish(); },
          onError: event => {
            const messages = { 2: '영상 주소가 올바르지 않아요.', 5: '이 브라우저에서 영상을 재생할 수 없어요.',
              100: '삭제됐거나 비공개인 영상이에요.', 101: '이 영상은 외부 플레이어 재생이 허용되지 않아요.',
              150: '이 영상은 외부 플레이어 재생이 허용되지 않아요.', 153: 'YouTube가 플레이어의 출처를 확인하지 못했어요.' };
            const message = messages[event.data] || 'YouTube 영상을 불러오지 못했어요.';
            statusText.textContent = message;
            if (pending) send('error', { request: pending.request, message });
          },
        },
      });
      readyTimer = setTimeout(() => {
        if (!ready && pending) send('error', { request: pending.request, message: 'YouTube 플레이어 준비가 오래 걸려요.' });
      }, 15000);
    } else if (ready) {
      player.cueVideoById({ videoId: value.id });
      send('player-ready', { request: value.request });
    }
  } catch (error) {
    if (pending === value) { statusText.textContent = error.message; send('error', { request: value.request, message: error.message }); }
  }
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== parentOrigin || !event.data) return;
  const data = event.data;
  if (data.type === 'load' && /^[A-Za-z0-9_-]{11}$/.test(data.id) && Number.isSafeInteger(data.request)) {
    loadVideo({ id: data.id, request: data.request });
  } else if (data.type === 'seek' && ready && pending && data.request === pending.request && Number.isFinite(data.time)) {
    player.seekTo(Math.max(0, data.time), true);
  } else if (data.type === 'pause' && ready && pending && data.request === pending.request) {
    player.pauseVideo();
  }
});
setInterval(publish, 400);
send('preview-ready');
