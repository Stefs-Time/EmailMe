// Chart.js wrappers with a validated palette (light surface, CVD-checked).
// Colour follows the entity: the same series always gets the same colour.
export const SERIES = {
  added: '#2f6fb5',
  suppressed: '#c4302b',
  hard: '#c4302b',
  soft: '#b8860b',
  complaint: '#8e3a8a',
  review: '#2f6fb5',
  opens: '#2f6fb5',
  clicks: '#0f8f82',
  bounces: '#c4302b',
  campaign: '#2f6fb5',
  optin: '#0f8f82',
  test: '#b8860b',
};

const INK = '#5f6b7a';
const GRID = '#edf0f4';

function base() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { color: INK, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded' } },
      tooltip: { backgroundColor: '#1b2430', padding: 10, cornerRadius: 6, titleFont: { weight: '600' } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: INK, maxRotation: 0, autoSkipPadding: 12 }, border: { color: GRID } },
      y: { beginAtZero: true, grid: { color: GRID }, ticks: { color: INK, precision: 0 }, border: { display: false } },
    },
  };
}

const shortDay = (d) => new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });

export function lineChart(canvas, labels, series) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, borderColor: SERIES[s.key], backgroundColor: SERIES[s.key],
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25,
      })),
    },
    options: base(),
  });
}

export function stackedBars(canvas, labels, series) {
  const o = base();
  o.scales.x.stacked = true;
  o.scales.y.stacked = true;
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, backgroundColor: SERIES[s.key], borderColor: '#ffffff', borderWidth: { top: 2 },
        borderRadius: 3, borderSkipped: 'bottom', maxBarThickness: 22,
      })),
    },
    options: o,
  });
}

export function hbar(canvas, labels, data, key = 'added') {
  const o = base();
  o.indexAxis = 'y';
  o.plugins.legend.display = false;
  o.scales.x = { beginAtZero: true, grid: { color: GRID }, ticks: { color: INK, precision: 0 }, border: { display: false } };
  o.scales.y = { grid: { display: false }, ticks: { color: INK }, border: { color: GRID } };
  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: SERIES[key], borderRadius: 4, maxBarThickness: 16 }] },
    options: o,
  });
}

export { shortDay };
