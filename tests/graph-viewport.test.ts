import { describe, expect, it } from 'vitest';
import { anchoredGraphViewport, graphWheelPixels, graphWheelZoom, graphZoomLimits } from '../shared/graph-viewport';

describe('图谱滚轮与视口', () => {
  it('换算像素、行和页，并限制异常单次跳变', () => {
    expect(graphWheelPixels(32, 0, 600)).toBe(graphWheelPixels(2, 1, 600));
    expect(graphWheelPixels(0.1, 2, 600)).toBe(60);
    expect(graphWheelPixels(100000, 0, 600)).toBe(240);
    expect(graphWheelPixels(-100000, 1, 600)).toBe(-240);
    expect(graphWheelPixels(Number.NaN, 0, 600)).toBe(0);
  });
  it('普通滚轮明显缩放，触控板小步进保持平滑，正反方向互逆', () => {
    const wheel = graphWheelZoom(1, -100, 0, 600);
    expect(wheel).toBeGreaterThan(1.2);
    const trackpad = graphWheelZoom(1, -2, 0, 600);
    expect(trackpad).toBeGreaterThan(1); expect(trackpad).toBeLessThan(1.01);
    expect(graphWheelZoom(wheel, 100, 0, 600)).toBeCloseTo(1);
    expect(graphWheelZoom(1, 2, 1, 600)).toBeCloseTo(graphWheelZoom(1, 32, 0, 600));
  });
  it('放大缩小均锚定鼠标下同一个图谱坐标', () => {
    const original = { zoom: 0.7, pan: { x: -90, y: 45 } }, pointer = { x: 640, y: 280 };
    const graphPoint = { x: (pointer.x - original.pan.x) / original.zoom, y: (pointer.y - original.pan.y) / original.zoom };
    for (const target of [0.3, 1.2, 2.8]) {
      const next = anchoredGraphViewport(original, target, pointer);
      expect(graphPoint.x * next.zoom + next.pan.x).toBeCloseTo(pointer.x);
      expect(graphPoint.y * next.zoom + next.pan.y).toBeCloseTo(pointer.y);
    }
  });
  it('到达上下限后继续滚动不会移动画布，反向滚动仍可退出边界', () => {
    for (const limit of [graphZoomLimits.min, graphZoomLimits.max]) {
      const original = { zoom: limit, pan: { x: 12, y: -36 } }, pointer = { x: 500, y: 300 };
      const delta = limit === graphZoomLimits.max ? -120 : 120;
      const target = graphWheelZoom(limit, delta, 0, 600);
      expect(anchoredGraphViewport(original, target, pointer)).toEqual(original);
      expect(graphWheelZoom(limit, -delta, 0, 600)).not.toBe(limit);
    }
  });
  it('按钮围绕画布中心缩放，反向操作可回到原视口', () => {
    const original = { zoom: 1, pan: { x: 100, y: 80 } }, center = { x: 400, y: 250 };
    const next = anchoredGraphViewport(original, 1.25, center);
    expect(next.pan).toEqual({ x: 25, y: 37.5 });
    expect(anchoredGraphViewport(next, 1, center)).toEqual(original);
  });
});
