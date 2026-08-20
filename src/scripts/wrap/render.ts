/**
 * Renders a group's wrap as a PNG.
 *
 * Portrait 1080×1620 — Telegram scales photos to fit the bubble width, and a
 * tall card keeps the numbers legible on a phone without anyone tapping to
 * zoom. Everything is drawn with the 2D canvas API; no HTML, no headless
 * browser.
 */

import { createCanvas, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';

const W = 1080;
const H = 1660;

/** Deep indigo ground with a warm accent — reads as "review", not "report". */
const C = {
  bg: '#0F1226',
  bgAlt: '#161A34',
  ink: '#FFFFFF',
  ink2: '#B9C0DE',
  muted: '#6F79A8',
  accent: '#FFB03A',
  accent2: '#5AC8FA',
  bar: '#3B54C4',
  barTop: '#FFB03A',
};

/**
 * Font stack. Latin first, Ethiopic after it so Amharic names in a group fall
 * through instead of rendering as boxes.
 */
const SANS = '"DejaVu Sans","Liberation Sans","Noto Sans Ethiopic",sans-serif';

export function fontsAvailable(): { ok: boolean; missing: string[] } {
  const have = new Set(GlobalFonts.families.map(f => f.family));
  const missing = ['DejaVu Sans', 'Noto Sans Ethiopic'].filter(f => !have.has(f));
  return { ok: missing.length === 0, missing };
}

const fmt = (n: number) => n.toLocaleString('en-US');

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Truncates to fit a pixel width, so a long display name cannot overflow. */
function fit(ctx: SKRSContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function label(ctx: SKRSContext2D, text: string, x: number, y: number, color = C.muted) {
  ctx.font = `600 22px ${SANS}`;
  ctx.fillStyle = color;
  ctx.fillText(text.toUpperCase(), x, y);
}

export interface WrapView {
  title: string;
  periodLabel: string;
  messages: number;
  members: number;
  activeDays: number;
  perDay: number;
  avgLen: number;
  hours: number[];
  months: Array<[string, number]>;
  busiestDay: { day: string; n: number };
  top: Array<{ name: string; messages: number }>;
  awards: Array<{ title: string; who: string; detail: string }>;
  footer: string;
}

export function renderWrap(v: WrapView): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- ground ----
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // A soft radial glow behind the headline keeps the flat fill from looking dead.
  const glow = ctx.createRadialGradient(W / 2, 300, 40, W / 2, 300, 700);
  glow.addColorStop(0, 'rgba(91,120,255,0.28)');
  glow.addColorStop(1, 'rgba(15,18,38,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 900);

  const M = 72;
  let y = 118;

  // ---- masthead ----
  ctx.font = `700 26px ${SANS}`;
  ctx.fillStyle = C.accent;
  ctx.fillText('GROUP WRAPPED', M, y);
  y += 62;

  ctx.font = `700 56px ${SANS}`;
  ctx.fillStyle = C.ink;
  ctx.fillText(fit(ctx, v.title, W - M * 2), M, y);
  y += 44;

  ctx.font = `400 26px ${SANS}`;
  ctx.fillStyle = C.ink2;
  ctx.fillText(v.periodLabel, M, y);
  y += 74;

  // ---- hero number ----
  ctx.font = `700 148px ${SANS}`;
  ctx.fillStyle = C.ink;
  ctx.fillText(fmt(v.messages), M, y + 108);
  ctx.font = `600 30px ${SANS}`;
  ctx.fillStyle = C.accent2;
  ctx.fillText('messages sent', M, y + 150);
  y += 214;

  // ---- three supporting stats ----
  const cellW = (W - M * 2) / 3;
  const stats: Array<[string, string]> = [
    [fmt(v.members), 'people'],
    [fmt(v.perDay), 'per day'],
    [fmt(v.activeDays), 'active days'],
  ];
  stats.forEach(([n, l], i) => {
    const x = M + i * cellW;
    ctx.font = `700 46px ${SANS}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(n, x, y);
    label(ctx, l, x, y + 32);
  });
  y += 96;

  // ---- top talkers ----
  // Card height follows the number of rows; a small group must not leave a
  // blank band where a fifth name would have been.
  const rows = Math.max(1, v.top.length);
  ctx.fillStyle = C.bgAlt;
  roundRect(ctx, M - 24, y - 12, W - (M - 24) * 2, rows * 62 + 74, 28);
  ctx.fill();
  y += 40;
  label(ctx, 'Loudest voices', M, y, C.accent);
  y += 46;

  const maxTop = Math.max(...v.top.map(t => t.messages), 1);
  const barW = W - M * 2 - 180;
  v.top.forEach((t, i) => {
    const rowY = y + i * 62;

    ctx.font = `700 28px ${SANS}`;
    ctx.fillStyle = i === 0 ? C.accent : C.muted;
    ctx.fillText(String(i + 1), M, rowY);

    ctx.font = `${i === 0 ? 700 : 400} 28px ${SANS}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, t.name, 330), M + 40, rowY);

    // Bar sits under the name so a long name never collides with it.
    const w = Math.max(6, (t.messages / maxTop) * barW);
    ctx.fillStyle = i === 0 ? C.barTop : C.bar;
    roundRect(ctx, M + 40, rowY + 12, w, 10, 5);
    ctx.fill();

    ctx.font = `600 26px ${SANS}`;
    ctx.fillStyle = C.ink2;
    ctx.textAlign = 'right';
    ctx.fillText(fmt(t.messages), W - M, rowY);
    ctx.textAlign = 'left';
  });
  y += rows * 62 + 12;

  // ---- when the group is awake ----
  label(ctx, 'When this group is awake', M, y, C.accent);
  y += 34;

  const hMax = Math.max(...v.hours, 1);
  const hourW = (W - M * 2) / 24;
  const hourH = 140;
  const peakHour = v.hours.indexOf(hMax);
  v.hours.forEach((n, h) => {
    const bh = Math.max(3, (n / hMax) * hourH);
    ctx.fillStyle = h === peakHour ? C.accent : C.bar;
    roundRect(ctx, M + h * hourW + 3, y + hourH - bh, hourW - 6, bh, 4);
    ctx.fill();
  });
  y += hourH + 30;

  ctx.font = `400 22px ${SANS}`;
  ctx.fillStyle = C.muted;
  ctx.fillText('00:00', M, y);
  ctx.textAlign = 'center';
  ctx.fillText('12:00', W / 2, y);
  ctx.textAlign = 'right';
  ctx.fillText('23:00', W - M, y);
  ctx.textAlign = 'left';

  ctx.font = `600 26px ${SANS}`;
  ctx.fillStyle = C.accent2;
  ctx.fillText(
    `Peak hour ${String(peakHour).padStart(2, '0')}:00  ·  busiest day ${v.busiestDay.day} (${fmt(v.busiestDay.n)})`,
    M,
    y + 42
  );
  y += 78;

  // ---- awards ----
  label(ctx, 'Superlatives', M, y, C.accent);
  y += 20;

  const colW = (W - M * 2) / 2;
  v.awards.slice(0, 4).forEach((a, i) => {
    const cx = M + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * 132;

    ctx.fillStyle = C.bgAlt;
    roundRect(ctx, cx, cy, colW - 20, 112, 20);
    ctx.fill();

    // Accent rule instead of an icon: the bundled faces carry no emoji glyphs,
    // and a missing glyph leaves a hole where the eye expects a marker.
    ctx.fillStyle = C.accent;
    roundRect(ctx, cx + 20, cy + 22, 4, 68, 2);
    ctx.fill();

    ctx.font = `700 21px ${SANS}`;
    ctx.fillStyle = C.accent;
    ctx.fillText(a.title.toUpperCase(), cx + 40, cy + 38);

    ctx.font = `600 25px ${SANS}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, a.who, colW - 76), cx + 40, cy + 68);

    ctx.font = `400 20px ${SANS}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, a.detail, colW - 76), cx + 40, cy + 94);
  });
  y += 2 * 132 + 30;

  // ---- footer ----
  ctx.fillStyle = C.muted;
  ctx.fillRect(M, y, W - M * 2, 1);
  ctx.font = `400 22px ${SANS}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(v.footer, M, y + 40);

  return canvas.toBuffer('image/png');
}
