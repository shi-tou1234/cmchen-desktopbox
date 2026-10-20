'use strict';

// 频谱的四种画法：柱状 / 点阵 / 电平块 / 曲线（对称柱复用柱状）。
//
// 从 viz.js 拆出来的：这里只负责"把一个 view 画到 canvas 上"，不碰数据平滑、计时和设置。
// view 由 viz.js 每帧拼好：
//   { ctx, box, bars, peaks, palette, gradients, config, beat }
//   box 里带齐版式常量（padX/gap/barW/baseY/maxH/centerY/segH/blockCount/capH/radiusRatio/reflectScale）

(function () {
  function barX(box, i) {
    return box.padX + i * (box.barW + box.gap);
  }

  // 柱顶圆角、柱脚方角的柱子（底部要贴着基线，圆角会在基线上留一道缝）
  function topRounded(path, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    path.moveTo(x, y + h);
    path.lineTo(x, y + rr);
    path.arcTo(x, y, x + rr, y, rr);
    path.lineTo(x + w - rr, y);
    path.arcTo(x + w, y, x + w, y + rr, rr);
    path.lineTo(x + w, y + h);
    path.closePath();
  }

  // 倒影：贴基线那头是方角，远端（＝柱顶的镜像）是圆角
  function bottomRounded(path, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    path.moveTo(x, y);
    path.lineTo(x, y + h - rr);
    path.arcTo(x, y + h, x + rr, y + h, rr);
    path.lineTo(x + w - rr, y + h);
    path.arcTo(x + w, y + h, x + w, y + h - rr, rr);
    path.lineTo(x + w, y);
    path.closePath();
  }

  // 柱状／对称柱
  function bars(view, mirror) {
    const { ctx, box, bars: values, peaks, palette, gradients, config, beat } = view;
    const path = new Path2D();
    let any = false;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v < 0.015) continue;                     // 太矮的直接不画：宁可空着，也不留一排小疙瘩
      const x = barX(box, i);
      if (mirror) {
        const half = (v * box.maxH) / 2;
        path.roundRect(x, box.centerY - half, box.barW, half * 2, box.barW / 2);
      } else {
        const bh = v * box.maxH;
        topRounded(path, x, box.baseY - bh, box.barW, bh, box.barW * box.radiusRatio);
      }
      any = true;
    }
    if (!any) return;

    ctx.save();
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 12 + beat * 10;
    ctx.fillStyle = mirror ? gradients.mirror : gradients.bar;
    ctx.fill(path);
    ctx.restore();

    // 倒影只在"立在地上"的柱状造型里有意义；对称柱本身就是镜像
    if (!mirror && config.reflect) {
      const reflect = new Path2D();
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        if (v < 0.015) continue;
        bottomRounded(reflect, barX(box, i), box.baseY, box.barW, v * box.maxH * box.reflectScale, box.barW * box.radiusRatio);
      }
      ctx.fillStyle = gradients.reflect;
      ctx.fill(reflect);
    }

    // 对称柱两端都有柱顶，画单侧亮帽反而不对称，索性不画
    if (!mirror) {
      const caps = new Path2D();
      let has = false;
      for (let i = 0; i < values.length; i += 1) {
        const p = peaks[i];
        if (p <= 0 || p < values[i] + 0.06) continue;
        caps.roundRect(barX(box, i), box.baseY - p * box.maxH - box.capH - 3, box.barW, box.capH, box.capH / 2);
        has = true;
      }
      if (has) {
        ctx.fillStyle = palette.cap;
        ctx.fill(caps);
      }
    }
  }

  // 点阵：每段一颗光点，大小随能量，下面拖一根极淡的杆
  function dots(view) {
    const { ctx, box, bars: values, palette, gradients, beat } = view;
    const stems = new Path2D();
    const path = new Path2D();
    let any = false;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v < 0.015) continue;
      const cx = barX(box, i) + box.barW / 2;
      const cy = box.baseY - v * box.maxH;
      const r = box.barW * (0.30 + v * 0.24);
      stems.moveTo(cx, cy + r);
      stems.lineTo(cx, box.baseY);
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, Math.PI * 2);
      any = true;
    }
    if (!any) return;

    ctx.strokeStyle = palette.stem;
    ctx.lineWidth = 1;
    ctx.stroke(stems);

    ctx.save();
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 14 + beat * 12;
    ctx.fillStyle = gradients.bar;
    ctx.fill(path);
    ctx.restore();
  }

  // 电平块：每列固定段数 LED，亮到哪一格就画到哪一格（未亮的留极淡的灯座）
  function blocks(view) {
    const { ctx, box, bars: values, palette, gradients, beat } = view;
    const off = new Path2D();
    const on = new Path2D();
    let any = false;
    for (let i = 0; i < values.length; i += 1) {
      const x = barX(box, i);
      const lit = Math.round(values[i] * box.blockCount);
      for (let s = 0; s < box.blockCount; s += 1) {
        const h = box.segH - 3;
        const y = box.baseY - (s + 1) * box.segH + 1.5;
        const r = Math.min(2, box.barW / 2);
        (s < lit ? on : off).roundRect(x, y, box.barW, h, r);
        if (s < lit) any = true;
      }
    }
    if (!any) return;
    ctx.fillStyle = palette.blockOff;
    ctx.fill(off);

    ctx.save();
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 10 + beat * 8;
    ctx.fillStyle = gradients.bar;
    ctx.fill(on);
    ctx.restore();
  }

  // 曲线：把所有柱顶用二次贝塞尔串成一条发光的细线（不填充，轻）
  function line(view, withAlpha) {
    const { ctx, box, bars: values, palette, gradients, beat } = view;
    const pts = [];
    for (let i = 0; i < values.length; i += 1) {
      pts.push([barX(box, i) + box.barW / 2, box.baseY - values[i] * box.maxH]);
    }
    const path = new Path2D();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) {
      const [px, py] = pts[i - 1];
      const [cx, cy] = pts[i];
      path.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2);
    }
    const last = pts[pts.length - 1];
    path.lineTo(last[0], last[1]);

    ctx.save();
    ctx.strokeStyle = gradients.bar;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 14 + beat * 12;
    ctx.stroke(path);
    ctx.restore();

    // 线下面垫一层很淡的填充，让"山形"有个体积感，又不至于像实心块
    const fill = new Path2D(path);
    fill.lineTo(last[0], box.baseY);
    fill.lineTo(pts[0][0], box.baseY);
    fill.closePath();
    ctx.fillStyle = withAlpha(palette.bar[1], 0.10);
    ctx.fill(fill);
  }

  window.VizPainters = { bars, dots, blocks, line };
})();
