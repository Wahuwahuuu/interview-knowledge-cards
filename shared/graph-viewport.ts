export type GraphPoint = { x: number; y: number };
export type GraphViewport = { zoom: number; pan: GraphPoint };
export const graphZoomLimits = { min: 0.05, max: 3 };

/** Wheels report pixels, lines, or pages; trackpads usually report small pixels. */
export function graphWheelPixels(delta: number, mode: number, pageHeight: number): number {
  if (!Number.isFinite(delta)) return 0;
  const unit = mode === 1 ? 16 : mode === 2 ? Math.max(1, pageHeight) : 1;
  return Math.max(-240, Math.min(240, delta * unit));
}

export function graphWheelZoom(zoom: number, delta: number, mode: number, pageHeight: number): number {
  return Math.max(graphZoomLimits.min, Math.min(graphZoomLimits.max, zoom * Math.exp(-graphWheelPixels(delta, mode, pageHeight) * 0.0025)));
}

/** Keep the graph coordinate under the pointer fixed, even at zoom limits. */
export function anchoredGraphViewport(viewport: GraphViewport, requestedZoom: number, point: GraphPoint): GraphViewport {
  const zoom = Math.max(graphZoomLimits.min, Math.min(graphZoomLimits.max, requestedZoom));
  const ratio = zoom / viewport.zoom;
  return { zoom, pan: { x: point.x - (point.x - viewport.pan.x) * ratio, y: point.y - (point.y - viewport.pan.y) * ratio } };
}
