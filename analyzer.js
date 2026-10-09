// analyzer.js - 브라우저/Node 공용 음역 분석기 (의존성 없음, ES module)
// Python 기준(analyze_detail.py: librosa pYIN, sr 16000, hop 256, C2~C6)을 YIN으로 재현한다.
//
// 사용: import { analyze, midiToKoreanNote } from './analyzer.js'
//       const r = analyze(float32Mono, sampleRate)
//       r = { lowest, highest, comfortLow, comfortHigh, accuracy25, vibratoShare, ... } (MIDI 숫자/비율)

export const SR = 16000;
export const HOP = 256;
const HOP_SEC = HOP / SR;
const FMIN = 65.406; // C2
const FMAX = 1046.5; // C6

// 튜닝 가능한 파라미터 (validate.mjs로 Python 결과와 맞춘 값)
export const DEFAULTS = {
  frame: 1024,        // YIN 적분 창 (64ms)
  yinThreshold: 0.10, // CMNDF 최소값이 이보다 작아야 유성음(= pYIN voiced prob 대체)
  rmsGateDb: -45,     // 녹음 최대 RMS 대비 이보다 작은 프레임은 무성음 처리
  medianFilter: 5,    // 피치 궤적 중앙값 필터(프레임 수, 홀수). 옥타브 튐 억제
};

// ---------- 리샘플링 (windowed-sinc, 다운샘플 시 저역통과 포함) ----------
export function resample(x, fromSr, toSr = SR) {
  if (fromSr === toSr) return x instanceof Float32Array ? x : Float32Array.from(x);
  const ratio = toSr / fromSr;
  const outLen = Math.floor(x.length * ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.95; // 정규화 차단 주파수
  const width = Math.ceil(16 / cutoff);    // 커널 반폭(입력 샘플)
  // 커널 테이블 (입력 샘플당 RES 단계) - sin/cos 반복 계산 제거
  const RES = 512;
  const tab = new Float32Array(width * RES + 2);
  for (let j = 0; j < tab.length; j++) {
    const t = j / RES, d = t * cutoff;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    tab[j] = t >= width ? 0 : sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / width));
  }
  for (let i = 0; i < outLen; i++) {
    const t = i / ratio;
    const c = Math.floor(t);
    let acc = 0, wsum = 0;
    const k0 = Math.max(0, c - width + 1), k1 = Math.min(x.length - 1, c + width);
    for (let k = k0; k <= k1; k++) {
      const pos = Math.abs(t - k) * RES;
      const j = pos | 0;
      const h = tab[j] + (tab[j + 1] - tab[j]) * (pos - j);
      acc += x[k] * h;
      wsum += h;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

// ---------- FFT (radix-2, in-place) ----------
function makeFFT(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const s = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const halfSize = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const wr = cos[j * step], wi = s * sin[j * step];
          const a = i + j, b = a + halfSize;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// ---------- YIN 피치 추적 ----------
// 반환: Float64Array(프레임 수), 유성음이면 MIDI, 아니면 NaN
export function pitchTrack(y, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const W = o.frame;
  const tauMin = Math.floor(SR / FMAX);
  const tauMax = Math.ceil(SR / FMIN);
  const L = W + tauMax;
  let N = 1;
  while (N < L) N <<= 1; // 0..tauMax 지연만 쓰므로 순환 겹침 없음
  const fft = makeFFT(N);
  const nFrames = Math.max(0, Math.floor((y.length - L) / HOP) + 1);
  const midi = new Float64Array(nFrames).fill(NaN);
  const rms = new Float64Array(nFrames);

  // 누적 제곱합 (창 에너지 O(1) 계산)
  const cs = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cs[i + 1] = cs[i] + y[i] * y[i];

  const aRe = new Float64Array(N), aIm = new Float64Array(N);
  const bRe = new Float64Array(N), bIm = new Float64Array(N);
  const d = new Float64Array(tauMax + 1);
  const cm = new Float64Array(tauMax + 1);

  let maxRms = 0;
  for (let f = 0; f < nFrames; f++) {
    const s = f * HOP;
    rms[f] = Math.sqrt((cs[s + W] - cs[s]) / W);
    if (rms[f] > maxRms) maxRms = rms[f];
  }
  const gate = maxRms * Math.pow(10, o.rmsGateDb / 20);

  for (let f = 0; f < nFrames; f++) {
    if (rms[f] < gate) continue;
    const s = f * HOP;
    // a(실수부)와 b(허수부)를 한 번의 FFT로 처리 후 분리
    aRe.fill(0); aIm.fill(0);
    for (let i = 0; i < W; i++) aRe[i] = y[s + i];
    for (let i = 0; i < L; i++) aIm[i] = y[s + i];
    fft(aRe, aIm, false);
    for (let k = 0; k < N; k++) {
      const nk = (N - k) & (N - 1);
      const zr = aRe[k], zi = aIm[k], wr = aRe[nk], wi = -aIm[nk]; // w = conj(Z[N-k])
      const Ar = (zr + wr) / 2, Ai = (zi + wi) / 2;          // A = (Z + conj Z[N-k]) / 2
      const Br = (zi - wi) / 2, Bi = -(zr - wr) / 2;         // B = (Z - conj Z[N-k]) / 2i
      bRe[k] = Ar * Br + Ai * Bi;                            // conj(A) * B
      bIm[k] = Ar * Bi - Ai * Br;
    }
    fft(bRe, bIm, true);
    const e0 = cs[s + W] - cs[s];
    for (let tau = 0; tau <= tauMax; tau++) {
      const et = cs[s + tau + W] - cs[s + tau];
      d[tau] = e0 + et - (2 * bRe[tau]) / N;
    }
    // CMNDF
    cm[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    // 임계값 아래 첫 국소 최소
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < o.yinThreshold) {
        while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;
    // 포물선 보간
    let t = best;
    if (best > 1 && best < tauMax) {
      const a = cm[best - 1], b = cm[best], c = cm[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0) t = best + (0.5 * (a - c)) / den;
    }
    const hz = SR / t;
    if (hz < FMIN || hz > FMAX) continue;
    midi[f] = 69 + 12 * Math.log2(hz / 440);
  }

  // 중앙값 필터(유성 프레임끼리만): 단발성 옥타브 튐 제거
  if (o.medianFilter > 1) {
    const h = (o.medianFilter - 1) >> 1;
    const src = Float64Array.from(midi);
    for (let i = 0; i < nFrames; i++) {
      if (isNaN(src[i])) continue;
      const w = [];
      for (let k = i - h; k <= i + h; k++) if (k >= 0 && k < nFrames && !isNaN(src[k])) w.push(src[k]);
      midi[i] = median(w);
    }
  }
  return midi;
}

// ---------- 통계 유틸 ----------
function median(arr) {
  if (!arr.length) return NaN;
  const a = Array.from(arr).sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function percentile(sorted, p) { // numpy linear
  if (!sorted.length) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// 지속음 구간: 구간 중앙값에서 0.6반음 이내로 유지된 연속 유성 프레임
export function segments(midi, minSec) {
  const need = Math.floor(minSec / HOP_SEC);
  const out = [];
  let start = -1;
  for (let i = 0; i <= midi.length; i++) {
    const cur = i < midi.length ? midi[i] : NaN;
    if (start >= 0 && (isNaN(cur) || Math.abs(cur - median(midi.subarray(start, i))) > 0.6)) {
      if (i - start >= need) out.push(midi.slice(start, i));
      start = -1;
    }
    if (start < 0 && !isNaN(cur)) start = i;
  }
  return out;
}

function heldExtreme(segs, top, below = Infinity) {
  const cen = segs.map(median);
  const dur = segs.map((s) => s.length * HOP_SEC);
  const ok = cen.filter((c, i) => c < below && (dur[i] >= 0.4 || cen.filter((x) => Math.abs(x - c) <= 0.5).length >= 2));
  if (!ok.length) return null;
  if (top) return Math.max(...ok);
  // 최저음 쪽 고립 이상치 제거: 다음 후보와 5반음 넘게 떨어진 외톨이 저음은 서브하모닉(옥타브 아래 오검출)으로 본다
  ok.sort((a, b) => a - b);
  let i = 0;
  while (i < ok.length - 1 && ok[i + 1] - ok[i] > 5) i++;
  return ok[i];
}

function vibratoShare(segs) {
  const longs = segs.filter((s) => s.length * HOP_SEC >= 0.6);
  if (!longs.length) return { share: null, n: 0 };
  let hit = 0;
  for (const s of longs) {
    const n = s.length;
    // 1차 추세 제거 (센트)
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += s[i]; sxx += i * i; sxy += i * s[i]; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const icp = (sy - slope * sx) / n;
    const c = new Float64Array(n);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      c[i] = (s[i] - (slope * i + icp)) * 100;
      if (c[i] < mn) mn = c[i];
      if (c[i] > mx) mx = c[i];
    }
    // Hann 창 + DFT 크기 (rfft)
    const nb = Math.floor(n / 2) + 1;
    const spec = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) {
        const w = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1; // np.hanning
        const v = c[i] * w;
        re += v * Math.cos((2 * Math.PI * k * i) / n);
        im -= v * Math.sin((2 * Math.PI * k * i) / n);
      }
      spec[k] = Math.hypot(re, im);
    }
    let bandMax = -1;
    for (let k = 0; k < nb; k++) {
      const fq = k / (n * HOP_SEC);
      if (fq >= 4 && fq <= 8 && spec[k] > bandMax) bandMax = spec[k];
    }
    const med = median(spec.subarray(1));
    if (bandMax >= 0 && bandMax > 1.5 * med && mx - mn > 40) hit++;
  }
  return { share: hit / longs.length, n: longs.length };
}

// ---------- 메인 ----------
export function analyze(samples, sampleRate, opts = {}) {
  const y = resample(samples, sampleRate, SR);
  const midi = pitchTrack(y, opts);
  return analyzeMidi(midi);
}

export function analyzeMidi(midi) {
  const voiced = Array.from(midi).filter((m) => !isNaN(m)).sort((a, b) => a - b);
  const segs02 = segments(midi, 0.2);
  const segs03 = segments(midi, 0.3);

  // 음 중심 정확도: 0.3초 이상 지속음 중앙값의 반음 격자 오차(곡별 중앙 오프셋 보정)
  const offs = segs03.map(median).map((c) => (c - Math.round(c)) * 100);
  const tuning = offs.length ? median(offs) : 0;
  const dev = offs.map((o) => Math.abs(((((o - tuning) + 50) % 100) + 100) % 100 - 50));
  const vib = vibratoShare(segs03);

  return {
    lowest: heldExtreme(segs02, false),
    highest: heldExtreme(segs02, true),
    comfortLow: voiced.length ? percentile(voiced, 25) : null,
    comfortHigh: voiced.length ? percentile(voiced, 75) : null,
    accuracy25: dev.length ? dev.filter((v) => v <= 25).length / dev.length : null,
    vibratoShare: vib.share,
    // 진단용
    median: voiced.length ? percentile(voiced, 50) : null,
    voicedSec: voiced.length * HOP_SEC,
    nSegments: segs03.length,
    nLongNotes: vib.n,
    _midi: midi, // 프레임별 MIDI (UI 그래프용)
  };
}

// 상한 제한 최고음 (예: 가성/코러스 제외하고 C5 미만에서의 안정 최고음)
export function highestBelow(midi, limitMidi) {
  return heldExtreme(segments(midi, 0.2), true, limitMidi);
}

// ---------- 음이름 ----------
const INTL = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KO = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
export function midiToKoreanNote(midi) {
  if (midi == null || isNaN(midi)) return { intl: '-', ko: '-' };
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1; // MIDI 60 = C4
  const kOct = oct - 2; // C4~B4 = 2옥, C3~B3 = 1옥, C5~B5 = 3옥 (C2~B2 = 0옥)
  return { intl: `${INTL[pc]}${oct}`, ko: `${kOct}옥 ${KO[pc]}` };
}
