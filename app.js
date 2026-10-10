// app.js - 노래방 선곡 코치. 고른 곡의 원곡 최고음으로 음역을 추정하고, 상황별 곡과 키, 부르는 포인트를 고른다.
// 서버 없음. 모든 계산은 브라우저 안에서 한다.

const $ = (id) => document.getElementById(id);
const screens = ['s-intro', 's-situation', 's-pick', 's-result'];
const show = (id) => { screens.forEach((s) => $(s).classList.toggle('hidden', s !== id)); window.scrollTo(0, 0); };

// 익명 이용 통계. 어떤 단계까지 왔는지만 남긴다(개인 식별 정보 없음). 실패해도 화면에는 영향 없음.
const DB_URL = 'https://wdgvonpejhvrnbngplgn.supabase.co/rest/v1/karaoke_events';
const DB_KEY = 'sb_publishable_wdqLPEt9V5BPQsLKFIMV8Q_yiSVp4Yo'; // 공개용(publishable) 키. 쓰기만 허용, 읽기는 막혀 있다
const SESSION = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 36);
const SRC = (new URLSearchParams(location.search).get('src') || '').slice(0, 30) || null;
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const track = (event, data = {}) => {
  const row = { event, session: SESSION, src: SRC, situation: data.situation ?? null, picks: data.picks ?? null, song: data.song ? String(data.song).slice(0, 60) : null, choice: data.choice ?? null, est_lo: data.estLo ?? null };
  if (LOCAL) { console.log('[track]', row); return; }
  fetch(DB_URL, { method: 'POST', keepalive: true, headers: { apikey: DB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(row) }).catch(() => {});
};

const KO = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const note = (m) => `${Math.floor(m / 12) - 3}옥 ${KO[((m % 12) + 12) % 12]}`; // C4 = 2옥 도

const SITUATION = {
  호감: { label: '마음에 드는 사람 앞에서', recTitle: '마음에 드는 사람 앞에서 부를 곡' },
  친구: { label: '친구들과', recTitle: '친구들 앞에서 한 곡 제대로 보여 줄 곡' },
  회식: { label: '회식에서', recTitle: '회식에서 무난하게 분위기 맞출 곡' },
};

let songs = [];
let situation = null;
const marks = new Map(); // title -> 'easy' | 'hard'

fetch('./songs.json').then((r) => r.json()).then((d) => { songs = d; renderPicks(); });
track('visit');

// ---------- 곡 고르기 ----------
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chips = (t, m) => `<div class="chips">
  <button class="chip easy ${m === 'easy' ? 'on' : ''}" data-t="${esc(t)}" data-v="easy">편해요</button>
  <button class="chip hard ${m === 'hard' ? 'on' : ''}" data-t="${esc(t)}" data-v="hard">버거워요</button></div>`;

function renderPicks() {
  const raw = $('q').value.trim();
  const q = raw.toLowerCase().replace(/\s/g, '');
  const hit = (s) => !q || `${s.title}${s.artist}`.toLowerCase().replace(/\s/g, '').includes(q);
  // 키 계산이 되는 곡(★)을 먼저 보여 준다
  const list = songs.filter(hit).sort((a, b) => (b.high != null) - (a.high != null));
  let html = list.map((s) => `<div class="pick">
      <div><div style="font-weight:700">${s.high != null ? '★ ' : ''}${esc(s.title)}</div><div class="small muted">${esc(s.artist)}${s.custom ? ', 직접 추가' : ''}</div></div>
      ${chips(s.title, marks.get(s.title))}</div>`).join('');
  if (raw && !songs.some((s) => s.title.toLowerCase().replace(/\s/g, '') === q)) {
    html += `<div class="pick"><div><div style="font-weight:700">"${esc(raw)}" 직접 추가</div><div class="small muted">목록에 없는 곡도 골라 주세요. 모인 답으로 이 곡의 키를 분석해요.</div></div>${chips('__custom__', null)}</div>`;
  }
  $('pick-list').innerHTML = html;
  const easyKnown = songs.filter((s) => s.high != null && marks.get(s.title) === 'easy').length;
  $('btn-result').disabled = easyKnown === 0;
  $('btn-result').textContent = easyKnown === 0
    ? (marks.size ? '★ 곡 중 편한 곡을 하나 이상 골라 주세요' : '편한 곡을 하나 이상 골라 주세요')
    : `결과 보기 (${marks.size}곡 선택)`;
}

$('pick-list').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  let { t, v } = b.dataset;
  if (t === '__custom__') {
    t = $('q').value.trim().slice(0, 60);
    if (!t) return;
    if (!songs.some((s) => s.title === t)) songs.push({ title: t, artist: '', high: null, situations: [], custom: true });
  }
  if (marks.get(t) === v) marks.delete(t); else marks.set(t, v);
  renderPicks();
});
$('q').addEventListener('input', renderPicks);

// ---------- 추정 ----------
// 편한 곡 최고음의 최댓값 = 확실히 내는 음(하한). 버거운 곡 최고음의 최솟값 = 넘기 어려운 음(상한).
function estimate() {
  const pick = (v) => songs.filter((s) => marks.get(s.title) === v && s.high != null);
  const easy = pick('easy'), hard = pick('hard');
  const lo = Math.max(...easy.map((s) => s.high));
  const hiCandidates = hard.map((s) => s.high).filter((h) => h > lo);
  const hi = hiCandidates.length ? Math.min(...hiCandidates) : null;
  const conflict = hard.some((s) => s.high <= lo);
  return { lo, hi, conflict, easy, hard };
}

const MOOD_NAME = { '이별 감성': '감성 발라더', 짝사랑: '감성 발라더', 서정: '서정 발라더', 설렘: '설렘 보컬', 고백: '설렘 보컬', 신나는: '분위기 메이커', 위로: '서정 발라더', 우정: '분위기 메이커' };

function voiceType(lo, easy) {
  const tier = lo >= 71 ? ['고음 자신감', '높은 음도 원키로 소화해요. 고음으로 어필하는 곡을 골라도 무리가 없어요.']
    : lo >= 69 ? ['안정적인', '노래방 인기 발라드 대부분을 원키 또는 한두 키 낮춰 부를 수 있는 음역이에요.']
    : ['담백한', '고음으로 승부하기보다 중음에서 감정을 전하는 쪽이 잘 맞아요. 키를 낮추는 걸 두려워하지 마세요.'];
  const count = {};
  easy.forEach((s) => { const k = MOOD_NAME[s.mood] || '감성 발라더'; count[k] = (count[k] || 0) + 1; });
  const mood = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  return { name: `${tier[0]} ${mood}`, desc: tier[1] };
}

function keyOf(lo, high) {
  const d = lo - high;
  if (d >= 0) return { label: '원키', cls: 'ok', d };
  return { label: `${d}키`, cls: d >= -2 ? 'down' : 'hard', d };
}

// ---------- 결과 ----------
let last;
function renderResult() {
  const est = estimate();
  const type = voiceType(est.lo, est.easy);
  const range = !est.hi ? `${note(est.lo)} 이상` : est.hi - 1 > est.lo ? `${note(est.lo)} ~ ${note(est.hi - 1)}` : note(est.lo);
  $('r-eyebrow').textContent = `${SITUATION[situation].label}, 추정 진성 한계 ${range}`;
  $('r-type').textContent = type.name;
  $('r-desc').textContent = type.desc + (est.conflict ? ' (편하다고 고른 곡보다 낮은 곡을 버겁다고 고르셔서, 편한 곡 기준으로 계산했어요.)' : '');
  $('r-rec-title').textContent = SITUATION[situation].recTitle;

  const fit = songs.filter((s) => s.situations.includes(situation));
  const known = fit.filter((s) => s.high != null).map((s) => ({ ...s, key: keyOf(est.lo, s.high) }));
  const picked = new Set(marks.keys());
  const good = known.filter((s) => s.key.d >= -2)
    .sort((a, b) => (picked.has(a.title) - picked.has(b.title)) || Math.abs(a.key.d) - Math.abs(b.key.d));
  const recs = good.slice(0, 3);
  const pending = fit.filter((s) => s.high == null && !s.custom).slice(0, Math.max(1, 3 - recs.length));

  $('r-recs').innerHTML = recs.map((s) => `
    <div class="rec">
      <div class="top"><div><div style="font-weight:700">${s.title}</div><div class="small muted">${s.artist}${s.tj ? `, TJ ${s.tj}` : ''}</div></div>
      <div class="key ${s.key.cls}">${s.key.label}</div></div>
      <div class="tip"><span class="tag">${s.mood}</span><span class="tag">${s.appeal} 어필</span><br>${s.tip}</div>
    </div>`).join('') +
    pending.map((s) => `
    <div class="rec">
      <div class="top"><div><div style="font-weight:700">${s.title}</div><div class="small muted">${s.artist}</div></div>
      <div class="key down">키 정보 준비 중</div></div>
      <div class="tip"><span class="tag">${s.mood}</span>이 자리에 어울리는 곡이에요. 키 정보는 이용자 답을 모으는 중이에요.</div>
    </div>`).join('') ||
    '<p class="small muted">이 상황에 맞는 곡을 아직 준비 중이에요.</p>';

  const avoid = known.filter((s) => s.key.d <= -3);
  $('r-avoid-card').classList.toggle('hidden', avoid.length === 0);
  $('r-avoid').innerHTML = avoid.map((s) => `${s.title}: 원곡 최고음 ${note(s.high)}, ${s.key.label} 이상 낮춰야 해요`).join('<br>');

  last = { type: type.name, range, recs };
  track('result', { situation, picks: marks.size });
  // 키를 모르는 곡에 대한 답은 추정 음역과 함께 남겨, 답이 쌓이면 그 곡의 최고음을 계산한다
  songs.filter((s) => s.high == null && marks.has(s.title))
    .forEach((s) => track('pick', { situation, song: s.title, choice: marks.get(s.title), estLo: est.lo }));
  show('s-result');
}

// ---------- 공유 카드 ----------
function drawCard() {
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px "Pretendard Variable", Pretendard, sans-serif`;
  g.fillStyle = '#12111a'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#ff6b8b'); grad.addColorStop(1, '#ffb36b');
  g.fillStyle = grad; g.fillRect(80, 120, 120, 10);
  g.fillStyle = '#ffb36b'; g.font = font(600, 40); g.fillText('노래방 선곡 코치', 80, 210);
  g.fillStyle = '#f3f1fa'; g.font = font(800, 92); g.fillText(last.type, 80, 330);
  g.fillStyle = '#a9a4bf'; g.font = font(500, 40); g.fillText(`추정 진성 한계 ${last.range}`, 80, 420);
  g.fillStyle = '#f3f1fa'; g.font = font(700, 48); g.fillText('오늘 부를 곡', 80, 560);
  last.recs.forEach((s, i) => {
    const y = 670 + i * 130;
    g.fillStyle = '#1d1b29'; g.beginPath(); g.roundRect(80, y - 70, W - 160, 105, 24); g.fill();
    g.fillStyle = '#f3f1fa'; g.font = font(700, 44); g.fillText(s.title, 120, y);
    g.fillStyle = s.key.cls === 'ok' ? '#5fd3a6' : '#ffc857'; g.font = font(800, 44);
    g.fillText(s.key.label, W - 120 - g.measureText(s.key.label).width, y);
  });
  g.fillStyle = '#a9a4bf'; g.font = font(500, 34); g.fillText('너는 몇 키야? 1분이면 나와요', 80, H - 110);
  return c;
}

async function share() {
  track('share_click', { situation });
  const blob = await new Promise((res) => drawCard().toBlob(res, 'image/png'));
  const file = new File([blob], 'my-karaoke-pick.png', { type: 'image/png' });
  const text = `나는 ${last.type}. 너는 몇 키야?`;
  const url = location.href.split('#')[0];
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: `${text}\n${url}` }); return; }
    if (navigator.share) { await navigator.share({ text, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  try { await navigator.clipboard.writeText(`${text}\n${url}`); } catch (e) {}
  $('btn-share').textContent = '이미지 저장, 링크 복사 완료';
}

// ---------- 연결 ----------
$('btn-start').addEventListener('click', () => { track('start'); show('s-situation'); });
document.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => { situation = b.dataset.s; show('s-pick'); }));
$('btn-result').addEventListener('click', renderResult);
$('btn-share').addEventListener('click', share);
$('btn-retry').addEventListener('click', () => { marks.clear(); $('q').value = ''; renderPicks(); show('s-situation'); });
