// app.js - 녹음 → 분석 → 결과 → 공유. 서버 없이 브라우저 안에서만 동작한다.
import { analyze, analyzeMidi, highestBelow, midiToKoreanNote } from './analyzer.js';

const REC_SEC = 30;
const MIN_SEC = 15;
const FALSETTO_LINE = 72; // C5. 이 위는 가성일 수 있어 키 추천에서 뺀다

const $ = (id) => document.getElementById(id);
const screens = ['s-intro', 's-rec', 's-busy', 's-result'];
const show = (id) => screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));
const note = (m) => midiToKoreanNote(m);

// 측정 지점. 지금은 콘솔에만 남긴다. 배포 시 분석 도구를 연결한다.
const track = (event, data = {}) => console.log('[track]', event, data);

let songs = [];
fetch('./songs.json').then((r) => r.json()).then((d) => { songs = d; });
track('visit');

// ---------- 녹음 ----------
let ctx, stream, proc, chunks, timer, startedAt;

async function startRecording() {
  track('record_start');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    alert('마이크 권한이 필요해요. 브라우저 설정에서 마이크를 허용해 주세요.');
    return;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  chunks = [];
  proc.onaudioprocess = (e) => {
    const x = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(x));
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const level = Math.min(1, Math.sqrt(s / x.length) * 6);
    $('meter').style.width = `${Math.round(level * 100)}%`;
  };
  src.connect(proc);
  proc.connect(ctx.destination);

  show('s-rec');
  startedAt = performance.now();
  $('btn-stop').disabled = true;
  $('btn-stop').textContent = `${MIN_SEC}초 뒤부터 끝낼 수 있어요`;
  timer = setInterval(tick, 200);
}

function tick() {
  const el = (performance.now() - startedAt) / 1000;
  const left = Math.max(0, REC_SEC - el);
  $('rec-sec').textContent = Math.ceil(left);
  $('ring-bar').setAttribute('stroke-dashoffset', String(615.75 * (left / REC_SEC)));
  if (el >= MIN_SEC && $('btn-stop').disabled) {
    $('btn-stop').disabled = false;
    $('btn-stop').textContent = '여기까지 할게요';
  }
  // 최근 0.5초 음높이를 대략 보여 준다(재미 요소, 결과에는 쓰지 않음)
  if (chunks.length > 4) {
    const recent = concat(chunks.slice(-4));
    const r = analyze(recent, ctx.sampleRate);
    const m = r.median;
    $('live-note').textContent = m ? note(m).ko : '…';
  }
  if (left <= 0) stopRecording();
}

function stopRecording() {
  clearInterval(timer);
  proc.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const sr = ctx.sampleRate;
  const samples = concat(chunks);
  ctx.close();
  runAnalysis(samples, sr, 'mic');
}

function concat(list) {
  const n = list.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
}

// ---------- 파일 ----------
async function fromFile(file) {
  track('file_upload');
  show('s-busy');
  const buf = await file.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let audio;
  try {
    audio = await ac.decodeAudioData(buf);
  } catch (e) {
    alert('이 파일은 읽을 수 없어요. m4a, mp3, wav 파일로 다시 시도해 주세요.');
    show('s-intro');
    return;
  }
  const ch = audio.getChannelData(0);
  ac.close();
  runAnalysis(new Float32Array(ch), audio.sampleRate, 'file');
}

// ---------- 분석 ----------
function runAnalysis(samples, sr, via) {
  show('s-busy');
  setTimeout(() => {
    const r = analyze(samples, sr);
    const chestHigh = highestBelow(r._midi, FALSETTO_LINE);
    if (r.highest == null || chestHigh == null || r.voicedSec < 5) {
      alert('길게 끈 음이 부족해서 분석하지 못했어요. 한 음을 반 박자 이상 끄는 후렴으로 다시 불러 주세요.');
      track('analysis_fail', { via, voicedSec: r.voicedSec });
      show('s-intro');
      return;
    }
    track('result', { via });
    renderResult(r, chestHigh);
  }, 50);
}

// 목소리 유형: 편한 음역의 중심과 진성 최고음으로 나눈다. 성별을 가정하지 않는다.
function voiceType(center, high) {
  const spread = high - center;
  if (spread >= 13) return ['반전 매력형', '평소엔 낮고 차분하게 머물다가, 필요할 때 높이 치고 올라가요. 벌스는 낮게 깔고 후렴에서 터지는 곡이 잘 어울려요.'];
  if (center < 55) return ['따뜻한 중저음형', '낮은 음역에서 목소리가 가장 편안해요. 이야기하듯 부르는 발라드에서 매력이 살아나요.'];
  if (center < 62) return ['균형 잡힌 중음형', '높지도 낮지도 않은 음역이 편해요. 키만 잘 맞추면 고를 수 있는 곡이 가장 많은 타입이에요.'];
  return ['맑은 고음형', '높은 음역에서 목소리가 편해요. 원키가 높은 곡도 크게 낮추지 않고 부를 수 있어요.'];
}

function keyAdvice(userHigh, songHigh) {
  const d = Math.round(userHigh - songHigh);
  if (d >= 0) return { cls: 'ok', label: d >= 3 ? `원키 OK (+${Math.min(d, 3)}까지)` : '원키 OK', sort: 0 };
  if (d >= -2) return { cls: 'down', label: `${d}키`, sort: -d };
  return { cls: 'hard', label: `${d}키`, sort: -d };
}

let last;
function renderResult(r, chestHigh) {
  const center = (r.comfortLow + r.comfortHigh) / 2;
  const [type, desc] = voiceType(center, chestHigh);
  $('r-type').textContent = type;
  $('r-desc').textContent = desc;

  // 음역 막대 (C2~C6)
  const lo = 36, hi = 84;
  const pct = (m) => `${((Math.min(hi, Math.max(lo, m)) - lo) / (hi - lo)) * 100}%`;
  const ticks = [48, 60, 72].map((m) => `<span class="tick" style="left:${pct(m)}">${note(m).ko}</span>`).join('');
  $('r-range').innerHTML = `
    <div class="track"></div>
    <div class="full" style="left:${pct(r.lowest)};width:calc(${pct(chestHigh)} - ${pct(r.lowest)})"></div>
    <div class="comfort" style="left:${pct(r.comfortLow)};width:calc(${pct(r.comfortHigh)} - ${pct(r.comfortLow)})"></div>
    ${ticks}`;

  const stat = (k, m) => `<div class="stat"><div class="k">${k}</div><div class="v">${note(m).ko}<small>${note(m).intl}</small></div></div>`;
  const acc = r.accuracy25 == null ? '-' : `${Math.round(r.accuracy25 * 100)}%`;
  $('r-stats').innerHTML =
    stat('진성 최고음', chestHigh) + stat('최저음', r.lowest) +
    `<div class="stat"><div class="k">편한 음역</div><div class="v" style="font-size:16px">${note(r.comfortLow).ko} ~ ${note(r.comfortHigh).ko}</div></div>` +
    `<div class="stat"><div class="k">음 중심 정확도</div><div class="v">${acc}<small>±25센트 안</small></div></div>`;

  // 3옥 위 고음
  const peak = r.highest;
  const hasFalsetto = peak != null && peak >= FALSETTO_LINE;
  $('r-falsetto').classList.toggle('hidden', !hasFalsetto);
  if (hasFalsetto) {
    $('r-falsetto-text').textContent =
      `${note(peak).ko}(${note(peak).intl})까지 올라갔어요. 가성이었다면 가성 음역이 넓은 편이에요. 키 추천은 진성 기준인 ${note(chestHigh).ko} 아래로 맞췄어요. 후렴 고음이 짧게 스치는 곡은 그 부분만 가성으로 넘기고 한 키 덜 낮춰도 돼요.`;
  }

  // 곡 추천
  const list = songs
    .map((s) => ({ ...s, adv: keyAdvice(chestHigh, s.high) }))
    .sort((a, b) => a.adv.sort - b.adv.sort || b.high - a.high);
  $('r-songs').innerHTML = list.map((s) => `
    <li class="song">
      <div><div class="t">${s.title}</div><div class="a">${s.artist}, 원곡 최고음 ${note(s.high).ko}${s.tj ? `, TJ ${s.tj}` : ''}</div></div>
      <div class="key ${s.adv.cls}">${s.adv.label}</div>
    </li>`).join('');

  last = { type, chestHigh, comfortLow: r.comfortLow, comfortHigh: r.comfortHigh, top: list.slice(0, 3) };
  show('s-result');
  window.scrollTo(0, 0);
}

// ---------- 공유 카드 ----------
function drawCard() {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px "Pretendard Variable", Pretendard, sans-serif`;
  g.fillStyle = '#12111a'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#ff6b8b'); grad.addColorStop(1, '#ffb36b');
  g.fillStyle = grad; g.fillRect(80, 120, 120, 10);

  g.fillStyle = '#ffb36b'; g.font = font(600, 40); g.fillText('노래방 내 키 찾기', 80, 210);
  g.fillStyle = '#f3f1fa'; g.font = font(800, 104); g.fillText(last.type, 80, 340);

  g.font = font(500, 40); g.fillStyle = '#a9a4bf';
  g.fillText(`진성 최고음  ${note(last.chestHigh).ko}`, 80, 450);
  g.fillText(`편한 음역  ${note(last.comfortLow).ko} ~ ${note(last.comfortHigh).ko}`, 80, 510);

  g.fillStyle = '#f3f1fa'; g.font = font(700, 48); g.fillText('내 키로 부를 곡', 80, 650);
  last.top.forEach((s, i) => {
    const y = 760 + i * 130;
    g.fillStyle = '#1d1b29'; roundRect(g, 80, y - 70, W - 160, 105, 24); g.fill();
    g.fillStyle = '#f3f1fa'; g.font = font(700, 44); g.fillText(s.title, 120, y);
    g.fillStyle = s.adv.cls === 'ok' ? '#5fd3a6' : '#ffc857'; g.font = font(800, 44);
    const t = s.adv.label; g.fillText(t, W - 120 - g.measureText(t).width, y);
  });
  g.fillStyle = '#a9a4bf'; g.font = font(500, 34);
  g.fillText('후렴 30초면 내 키가 나와요', 80, H - 110);
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

async function share() {
  track('share_click');
  const canvas = drawCard();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const file = new File([blob], 'my-karaoke-key.png', { type: 'image/png' });
  const text = `나는 ${last.type}, 진성 최고음 ${note(last.chestHigh).ko}. 너는 몇 키야?`;
  const url = location.href.split('#')[0];
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: `${text}\n${url}` });
      return;
    }
    if (navigator.share) { await navigator.share({ text, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  // 공유 기능이 없는 환경: 이미지 저장 + 링크 복사
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  try { await navigator.clipboard.writeText(`${text}\n${url}`); } catch (e) {}
  alert('결과 이미지를 저장하고 링크를 복사했어요. 카카오톡 대화방에 붙여 넣어 주세요.');
}

// ---------- 연결 ----------
$('btn-start').addEventListener('click', startRecording);
$('btn-stop').addEventListener('click', stopRecording);
$('file').addEventListener('change', (e) => e.target.files[0] && fromFile(e.target.files[0]));
$('btn-retry').addEventListener('click', () => { $('file').value = ''; show('s-intro'); });
$('btn-share').addEventListener('click', share);

// 개발용: 분석 결과 객체로 화면만 확인할 때 쓴다
window.__renderForTest = (midiArray) => {
  const r = analyzeMidi(Float32Array.from(midiArray));
  renderResult(r, highestBelow(r._midi, FALSETTO_LINE));
};
