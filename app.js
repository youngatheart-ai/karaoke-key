// app.js - 노래방 선곡 코치. 고른 곡의 원곡 최고음으로 음역을 추정하고, 상황별 곡과 키, 부르는 포인트를 고른다.
// 서버 없음. 모든 계산은 브라우저 안에서 한다.

const $ = (id) => document.getElementById(id);
const screens = ['s-intro', 's-situation', 's-pick', 's-result'];
const show = (id) => { screens.forEach((s) => $(s).classList.toggle('hidden', s !== id)); window.scrollTo(0, 0); };

// 측정 지점. 지금은 콘솔에만 남긴다. 배포 시 분석 도구를 연결한다.
const track = (event, data = {}) => console.log('[track]', event, data);

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
function renderPicks() {
  const q = $('q').value.trim().toLowerCase();
  const list = songs.filter((s) => s.high != null)
    .filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));
  $('pick-list').innerHTML = list.map((s) => {
    const m = marks.get(s.title);
    return `<div class="pick">
      <div><div class="t" style="font-weight:700">${s.title}</div><div class="small muted">${s.artist}</div></div>
      <div class="chips">
        <button class="chip easy ${m === 'easy' ? 'on' : ''}" data-t="${s.title}" data-v="easy">편해요</button>
        <button class="chip hard ${m === 'hard' ? 'on' : ''}" data-t="${s.title}" data-v="hard">버거워요</button>
      </div></div>`;
  }).join('') || '<p class="small muted" style="padding:12px 0">검색 결과가 없어요.</p>';
  const nEasy = [...marks.values()].filter((v) => v === 'easy').length;
  $('btn-result').disabled = nEasy === 0;
  $('btn-result').textContent = nEasy === 0 ? '편한 곡을 하나 이상 골라 주세요' : `결과 보기 (${marks.size}곡 선택)`;
}

$('pick-list').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const { t, v } = b.dataset;
  if (marks.get(t) === v) marks.delete(t); else marks.set(t, v);
  renderPicks();
});
$('q').addEventListener('input', renderPicks);
$('btn-missing').addEventListener('click', () => {
  const v = $('missing').value.trim();
  if (!v) return;
  track('missing_song', { song: v });
  $('missing').value = '';
  $('btn-missing').textContent = '고마워요';
  setTimeout(() => { $('btn-missing').textContent = '보내기'; }, 1500);
});

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
  const pending = fit.filter((s) => s.high == null).slice(0, Math.max(0, 3 - recs.length) + 1);

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
      <div class="tip"><span class="tag">${s.mood}</span>${s.tip.replace(/^초안: /, '')}</div>
    </div>`).join('') ||
    '<p class="small muted">이 상황에 맞는 곡을 아직 준비 중이에요.</p>';

  const avoid = known.filter((s) => s.key.d <= -3);
  $('r-avoid-card').classList.toggle('hidden', avoid.length === 0);
  $('r-avoid').innerHTML = avoid.map((s) => `${s.title}: 원곡 최고음 ${note(s.high)}, ${s.key.label} 이상 낮춰야 해요`).join('<br>');

  last = { type: type.name, range, recs };
  track('result', { situation, picks: marks.size });
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
  track('share_click');
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
