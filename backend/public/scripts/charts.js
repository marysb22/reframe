// Hand-rolled SVG chart helpers -- no external library (this codebase has
// no bundler/build step and no charting precedent anywhere; introducing an
// npm/CDN charting library would be new infrastructure for data volumes
// this small). Colors are read from the page's own CSS custom properties
// (--primary/--success/--danger/--warning/--info/--muted/--border/--text)
// so every chart automatically matches whichever page includes this file.
// Pass { rtl: true } to renderBarChart to flip bar order for RTL layouts.

(function () {
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  const PALETTE = [
    () => cssVar("--primary", "#2E7D78"),
    () => cssVar("--info", "#2563a8"),
    () => cssVar("--warning", "#B5730F"),
    () => cssVar("--success", "#1D7A4C"),
    () => cssVar("--danger", "#B3372E"),
  ];

  function escapeLabel(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** data: [{label, value, color?}] */
  function renderBarChart(container, data, opts = {}) {
    if (!data || !data.length) {
      container.innerHTML = '<div class="empty-state">No data for this range.</div>';
      return;
    }
    const rtl = !!opts.rtl;
    const fmt = opts.valueFormatter || ((v) => v);
    const W = 300, H = 150, padBottom = 26, padTop = 22, padSide = 6;
    const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
    const n = data.length;
    const plotW = W - padSide * 2;
    const barW = plotW / n;
    const items = rtl ? [...data].reverse() : data;
    const textColor = cssVar("--text", "#16211F");
    const mutedColor = cssVar("--muted", "#5D6C6A");
    const borderColor = cssVar("--border", "#E4E9E7");

    const bars = items.map((d, i) => {
      const v = Number(d.value) || 0;
      const h = ((H - padBottom - padTop) * v) / max;
      const x = padSide + i * barW;
      const y = H - padBottom - h;
      const color = d.color || PALETTE[i % PALETTE.length]();
      return `
        <rect x="${(x + barW * 0.18).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"></rect>
        <text x="${(x + barW * 0.5).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${textColor}">${escapeLabel(fmt(v))}</text>
        <text x="${(x + barW * 0.5).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${mutedColor}">${escapeLabel(d.label)}</text>
      `;
    }).join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" role="img" aria-label="Bar chart">
        <line x1="${padSide}" y1="${H - padBottom}" x2="${W - padSide}" y2="${H - padBottom}" stroke="${borderColor}" stroke-width="1"></line>
        ${bars}
      </svg>`;
  }

  /** data: [{label, value, color?}] */
  function renderDonutChart(container, data, opts = {}) {
    const size = opts.size || 150;
    const strokeW = opts.strokeWidth || 20;
    const r = 50 - strokeW / 2;
    const total = (data || []).reduce((s, d) => s + (Number(d.value) || 0), 0);
    const textColor = cssVar("--text", "#16211F");
    const mutedColor = cssVar("--muted", "#5D6C6A");
    const borderColor = cssVar("--border", "#E4E9E7");

    if (!data || !data.length || total <= 0) {
      container.innerHTML = '<div class="empty-state">No data for this range.</div>';
      return;
    }

    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const segments = data.map((d, i) => {
      const v = Number(d.value) || 0;
      const dash = (v / total) * circumference;
      const color = d.color || PALETTE[i % PALETTE.length]();
      const seg = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}"
          stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"></circle>`;
      offset += dash;
      return seg;
    }).join("");

    const legend = data.map((d, i) => {
      const color = d.color || PALETTE[i % PALETTE.length]();
      return `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:${mutedColor};">
        <span style="width:9px;height:9px;border-radius:3px;background:${color};display:inline-block;flex-shrink:0;"></span>
        <span>${escapeLabel(d.label)}: <strong style="color:${textColor};">${d.value}</strong></span>
      </div>`;
    }).join("");

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        <svg viewBox="0 0 100 100" style="width:${size}px;height:${size}px;flex-shrink:0;" role="img" aria-label="Donut chart">
          <circle cx="50" cy="50" r="${r}" fill="none" stroke="${borderColor}" stroke-width="${strokeW}" opacity="0.25"></circle>
          ${segments}
        </svg>
        <div style="display:flex;flex-direction:column;gap:6px;">${legend}</div>
      </div>`;
  }

  /** series: [{date, count}] */
  function renderSparkline(container, series, opts = {}) {
    const W = 300, H = 80, pad = 8;
    const mutedColor = cssVar("--muted", "#5D6C6A");
    const color = opts.color || cssVar("--primary", "#2E7D78");

    if (!series || !series.length) {
      container.innerHTML = '<div class="empty-state">No sessions logged in this range.</div>';
      return;
    }

    const max = Math.max(1, ...series.map((s) => Number(s.count) || 0));
    const n = series.length;
    const stepX = n > 1 ? (W - pad * 2) / (n - 1) : 0;
    const pointFor = (s, i) => {
      const x = pad + i * stepX;
      const y = H - pad - ((H - pad * 2) * (Number(s.count) || 0)) / max;
      return { x, y };
    };
    const pts = series.map(pointFor);
    const points = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dots = pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"></circle>`).join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" role="img" aria-label="Trend line">
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"></polyline>
        ${dots}
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:${mutedColor};margin-top:4px;">
        <span>${escapeLabel(series[0].date)}</span>
        <span>${escapeLabel(series[series.length - 1].date)}</span>
      </div>`;
  }

  window.renderBarChart = renderBarChart;
  window.renderDonutChart = renderDonutChart;
  window.renderSparkline = renderSparkline;
})();
