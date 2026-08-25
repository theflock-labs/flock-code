/* The sidebar and pane topbars scale via CSS `zoom` (--ui-scale). Whether
   getBoundingClientRect() returns zoom-scaled (visual) or unscaled (layout)
   coordinates differs by engine era: Chromium and post-standardization
   WebKit scale them, older WebKit does not. A tooltip portaled to the
   unzoomed <body> must therefore multiply any rect taken inside a zoomed
   subtree by the ancestors' cumulative zoom, or it lands short of its anchor
   (visibly so at the right edge of a wide window). Probe once instead of
   assuming an engine. */
let rectsIncludeZoomCache: boolean | null = null;
function rectsIncludeZoom(): boolean {
  if (rectsIncludeZoomCache === null) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:100px;height:1px;zoom:2;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    rectsIncludeZoomCache = Math.round(probe.getBoundingClientRect().width) === 200;
    probe.remove();
  }
  return rectsIncludeZoomCache;
}

/** Factor that converts `el`'s client rect into true viewport coordinates:
 *  1 when the engine already scales rects, else the product of every
 *  ancestor's `zoom`. */
export function rectZoomFactor(el: HTMLElement): number {
  if (rectsIncludeZoom()) return 1;
  let z = 1;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const v = parseFloat(getComputedStyle(n).zoom);
    if (!Number.isNaN(v) && v > 0) z *= v;
  }
  return z;
}
