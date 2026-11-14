'use strict';

// The trend chart of /stock chart: the daily closes of about the last month as a line, drawn as SVG and turned into a
// PNG with the bundled Cubic 11 font (no system font, as the game boards do).

const path = require('node:path');

const FONT_FILE = path.join(__dirname, '..', '..', 'games', 'assets', 'fonts', 'Cubic_11.ttf');
const WIDTH = 800;
const HEIGHT = 420;
const PAD = Object.freeze({ left: 80, right: 30, top: 70, bottom: 50 });

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/gu, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
}

function label(value) {
  if (!Number.isFinite(value)) return '';
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 10 ? 2 : 4;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function buildStockChartSvg({ quote, points }) {
  const closes = points.map((point) => point.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || Math.abs(max) * 0.01 || 1;
  const low = min - span * 0.08;
  const high = max + span * 0.08;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index) => PAD.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => PAD.top + (1 - (value - low) / (high - low)) * plotHeight;
  const rising = closes.at(-1) >= closes[0];
  const color = rising ? '#d64545' : '#1f9d55';
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.close).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${PAD.top + plotHeight} L${x(0).toFixed(1)},${PAD.top + plotHeight} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = low + (high - low) * (1 - fraction);
    const gy = PAD.top + fraction * plotHeight;
    return `<line x1="${PAD.left}" y1="${gy}" x2="${WIDTH - PAD.right}" y2="${gy}" stroke="#e3e6ea"/>` +
      `<text x="${PAD.left - 10}" y="${gy + 5}" text-anchor="end" font-size="14" fill="#5b6470">${escapeXml(label(value))}</text>`;
  }).join('');
  const first = points[0].date;
  const last = points.at(-1).date;
  const change = closes.at(-1) - closes[0];
  const changeText = `${change >= 0 ? '+' : '-'}${label(Math.abs(change))}（${(Math.abs(change / closes[0]) * 100).toFixed(2)}%）`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="${PAD.left}" y="34" font-size="22" fill="#1f2933">${escapeXml(`${quote.name}（${quote.symbol}）近一個月收盤走勢`)}</text>
<text x="${PAD.left}" y="58" font-size="15" fill="${color}">${escapeXml(`${label(closes.at(-1))} ${quote.currency}　區間 ${changeText}`)}</text>
${grid}
<path d="${area}" fill="${color}" fill-opacity="0.08"/>
<path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(closes.at(-1)).toFixed(1)}" r="5" fill="${color}"/>
<text x="${PAD.left}" y="${HEIGHT - 18}" font-size="14" fill="#5b6470">${escapeXml(first)}</text>
<text x="${WIDTH - PAD.right}" y="${HEIGHT - 18}" text-anchor="end" font-size="14" fill="#5b6470">${escapeXml(last)}</text>
</svg>`;
}

function renderStockChartPng(history) {
  if (!history?.points?.length) return null;
  const { Resvg } = require('@resvg/resvg-js');
  return Buffer.from(new Resvg(buildStockChartSvg(history), {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: 'Cubic 11', sansSerifFamily: 'Cubic 11' },
    fitTo: { mode: 'width', value: WIDTH },
  }).render().asPng());
}

module.exports = {
  buildStockChartSvg,
  renderStockChartPng,
};
