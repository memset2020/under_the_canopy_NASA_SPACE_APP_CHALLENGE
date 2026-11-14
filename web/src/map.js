// Minimal slippy map (docs/10 D-007): Web-Mercator tiles, pan/zoom, image overlays,
// render hooks for vector layers. Works with no network: tiles that fail just hide.
//
// Overlays are lat/lon-regular grids stretched linearly between their mercator-projected
// corners. Over a ~15 km site the mercator y-distortion across the grid is < 0.01 px
// per pixel, so the shortcut is invisible.

const TILE = 256;
const TILE_RETRIES = 2;
const RESIZE_SLACK = 120; // px a framed map may lose (a longer caption) before a zoom-in would be undone

export function lonLatToWorld(lon, lat, z) {
  const size = TILE * 2 ** z;
  const phi = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * size, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size];
}

export function worldToLonLat(x, y, z) {
  const size = TILE * 2 ** z;
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return [lon, (180 / Math.PI) * Math.atan(Math.sinh(n))];
}

export function createMap(container, opts = {}) {
  const tileUrl = opts.tileUrl ?? null;
  const minZoom = opts.minZoom ?? 3;
  const maxZoom = opts.maxZoom ?? 17;
  let center = opts.center ?? [0, 0];
  let zoom = opts.zoom ?? 4;
  const listeners = { click: new Set(), move: new Set() };
  const renderHooks = new Set();
  const overlays = new Map();
  const tiles = new Map();
  let frame = 0;

  container.classList.add("map");
  container.tabIndex = 0;
  const pane = (name) => {
    const el = document.createElement("div");
    el.className = `map-pane map-pane-${name}`;
    container.append(el);
    return el;
  };
  const panes = {
    tiles: pane("tiles"),
    live: pane("live"),
    base: pane("base"),
    compare: pane("compare"),
    labels: pane("labels"), // place names drawn over the data (GIBS reference layers)
    top: pane("top"),
  };
  // Extra tile layers (NASA GIBS, docs/10 D-054): { template, maxZoom, tiles: Map, el }.
  const tileLayers = new Map();
  let attributionEl = null;
  if (opts.attribution) {
    attributionEl = document.createElement("div");
    attributionEl.className = "map-attribution";
    attributionEl.textContent = opts.attribution;
    container.append(attributionEl);
  }
  // The street tiles can be swapped for a NASA basemap (basemap.js); off means none are requested.
  let streets = Boolean(tileUrl);

  const size = () => [container.clientWidth, container.clientHeight];
  const origin = () => {
    const [cx, cy] = lonLatToWorld(center[0], center[1], zoom);
    const [w, h] = size();
    return [cx - w / 2, cy - h / 2];
  };

  function project(lon, lat) {
    const [x, y] = lonLatToWorld(lon, lat, zoom);
    const [ox, oy] = origin();
    return [x - ox, y - oy];
  }

  function unproject(px, py) {
    const [ox, oy] = origin();
    return worldToLonLat(px + ox, py + oy, zoom);
  }

  function renderTiles() {
    if (!tileUrl) return;
    if (!streets) {
      for (const img of tiles.values()) img.remove();
      tiles.clear();
      return;
    }
    const [w, h] = size();
    const [ox, oy] = origin();
    const n = 2 ** zoom;
    const wanted = new Set();
    for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h) / TILE); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w) / TILE); tx += 1) {
        const key = `${zoom}/${tx}/${ty}`;
        wanted.add(key);
        let img = tiles.get(key);
        if (!img) {
          img = new Image();
          img.alt = "";
          img.draggable = false;
          img.className = "map-tile";
          img.decoding = "async";
          img.referrerPolicy = "strict-origin-when-cross-origin";
          img.addEventListener("error", () => img.classList.add("map-tile-failed"));
          const wrapped = ((tx % n) + n) % n;
          img.src = tileUrl.replace("{z}", zoom).replace("{x}", wrapped).replace("{y}", ty);
          tiles.set(key, img);
          panes.tiles.append(img);
        }
        img.style.transform = `translate(${tx * TILE - ox}px, ${ty * TILE - oy}px)`;
      }
    }
    for (const [key, img] of tiles) {
      if (!wanted.has(key)) {
        img.remove();
        tiles.delete(key);
      }
    }
  }

  // GIBS fills some no-data tiles with an opaque all-black PNG (no transparency, docs/10 D-063);
  // drawn over other days or the basemap it is a black square. A 32 × 32 average keeps any real pixel.
  const probe = document.createElement("canvas");
  probe.width = probe.height = 32;
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  function isFiller(img) {
    try {
      probeCtx.clearRect(0, 0, 32, 32);
      probeCtx.drawImage(img, 0, 0, 32, 32);
      const d = probeCtx.getImageData(0, 0, 32, 32).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 255 || d[i] || d[i + 1] || d[i + 2]) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Tiles above maxZoom are the deepest level, scaled up: GIBS layers stop at z6–z13.
  function renderTileLayer(layer) {
    const [w, h] = size();
    const [ox, oy] = origin();
    const zt = Math.min(zoom, layer.maxZoom);
    const scale = 2 ** (zoom - zt);
    const span = TILE * scale;
    const n = 2 ** zt;
    const wanted = new Set();
    for (let ty = Math.floor(oy / span); ty <= Math.floor((oy + h) / span); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(ox / span); tx <= Math.floor((ox + w) / span); tx += 1) {
        const key = `${zt}/${tx}/${ty}`;
        wanted.add(key);
        let img = layer.tiles.get(key);
        if (!img) {
          img = new Image();
          img.alt = "";
          img.draggable = false;
          img.className = "map-tile-live";
          img.decoding = "async";
          img.referrerPolicy = "strict-origin-when-cross-origin";
          if (layer.checkFiller) {
            img.crossOrigin = "anonymous"; // GIBS sends Access-Control-Allow-Origin: *, so pixels can be read
            img.addEventListener("load", () => isFiller(img) && img.classList.add("map-tile-failed"));
          }
          const wrapped = ((tx % n) + n) % n;
          const url = layer.template.replace("{z}", zt).replace("{x}", wrapped).replace("{y}", ty);
          // GIBS answers some tiles with a transient HTTP 500; a hidden failed tile is a square hole.
          let tries = 0;
          img.addEventListener("error", () => {
            // Hidden at once: while it waits to retry, a sized broken image shows a frame and an icon.
            img.classList.add("map-tile-failed");
            if (tries >= TILE_RETRIES || !img.isConnected) return;
            tries += 1;
            setTimeout(() => {
              img.classList.remove("map-tile-failed");
              img.removeAttribute("src");
              img.src = url;
            }, 700 * tries);
          });
          img.src = url;
          layer.tiles.set(key, img);
          layer.el.append(img);
        }
        img.style.width = img.style.height = `${span}px`;
        img.style.transform = `translate(${tx * span - ox}px, ${ty * span - oy}px)`;
      }
    }
    for (const [key, img] of layer.tiles) {
      if (!wanted.has(key)) {
        img.remove();
        layer.tiles.delete(key);
      }
    }
  }

  function renderOverlays() {
    for (const o of overlays.values()) {
      const [w, s, e, n] = o.bounds;
      const [x0, y0] = project(w, n);
      const [x1, y1] = project(e, s);
      Object.assign(o.el.style, {
        left: `${x0}px`,
        top: `${y0}px`,
        width: `${x1 - x0}px`,
        height: `${y1 - y0}px`,
      });
    }
  }

  function render() {
    frame = 0;
    renderTiles();
    for (const layer of tileLayers.values()) renderTileLayer(layer);
    renderOverlays();
    for (const fn of renderHooks) fn(api);
    for (const fn of listeners.move) fn(api);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // A view framed by fitBounds stays framed while the map changes size (the bar under the map grows
  // and shrinks with the caption, the header wraps, the window resizes), until the user moves it.
  let fitted = null; // { bounds, padding } or null

  function applyView(c, z) {
    center = [c[0], Math.max(-85, Math.min(85, c[1]))];
    zoom = Math.max(minZoom, Math.min(maxZoom, Math.round(z ?? zoom)));
    schedule();
  }

  function setView(c, z) {
    fitted = null;
    applyView(c, z);
  }

  // The highest whole zoom at which the box fits inside the map with `padding` px to spare.
  function fitZoom([w, s, e, n], padding) {
    const [cw, ch] = size();
    let z = maxZoom;
    for (; z > minZoom; z -= 1) {
      const [x0, y0] = lonLatToWorld(w, n, z);
      const [x1, y1] = lonLatToWorld(e, s, z);
      if (x1 - x0 <= cw - 2 * padding && y1 - y0 <= ch - 2 * padding) break;
    }
    return z;
  }

  function fitBounds(bounds, padding = 24) {
    const [w, s, e, n] = bounds;
    applyView([(w + e) / 2, (s + n) / 2], fitZoom(bounds, padding));
    fitted = { bounds, padding };
  }

  // On a resize, a framed box that no longer fits is framed again, at once. It zooms back in only
  // when the bigger box would still fit with RESIZE_SLACK px to spare: the caption under the map
  // changes its height by up to ~100 px from pass to pass, and the map must not step in and out
  // during playback, nor zoom in to a size the next caption would cut.
  function onResize() {
    if (fitted) {
      const [w, s, e, n] = fitted.bounds;
      const tight = fitZoom(fitted.bounds, fitted.padding);
      const roomy = fitZoom(fitted.bounds, fitted.padding + RESIZE_SLACK / 2);
      const z = tight < zoom ? tight : roomy > zoom ? roomy : zoom;
      if (z !== zoom) applyView([(w + e) / 2, (s + n) / 2], z);
    }
    schedule();
  }

  // Zoom by one level keeping the given container point fixed.
  function zoomAround(delta, px, py) {
    const z = Math.max(minZoom, Math.min(maxZoom, zoom + delta));
    if (z === zoom) return;
    fitted = null;
    const [lon, lat] = unproject(px, py);
    const [w, h] = size();
    const [wx, wy] = lonLatToWorld(lon, lat, z);
    center = worldToLonLat(wx - px + w / 2, wy - py + h / 2, z);
    zoom = z;
    schedule();
  }

  function panBy(dx, dy) {
    fitted = null;
    const [cx, cy] = lonLatToWorld(center[0], center[1], zoom);
    center = worldToLonLat(cx + dx, cy + dy, zoom);
    schedule();
  }

  // Pointer: drag pans; a press that moves < 5 px is a click; two fingers pinch-zoom.
  let drag = null;
  const touches = new Map();
  let pinch = null; // { dist, mid: [x, y] }
  const spread = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  };
  container.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest("[data-map-control]")) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    container.setPointerCapture(ev.pointerId);
    if (touches.size === 2) {
      pinch = spread();
      drag = null; // a pinch is never a click or a pan
      return;
    }
    drag = { x: ev.clientX, y: ev.clientY, moved: false, id: ev.pointerId };
  });
  container.addEventListener("pointermove", (ev) => {
    if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && touches.size === 2) {
      const now = spread();
      const r = container.getBoundingClientRect();
      // Whole zoom levels only (tiles are per level): step when the fingers spread or close enough.
      if (now.dist > pinch.dist * 1.35 || now.dist < pinch.dist * 0.74) {
        zoomAround(now.dist > pinch.dist ? 1 : -1, now.mid[0] - r.left, now.mid[1] - r.top);
        pinch = now;
      }
      return;
    }
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    container.classList.add("map-dragging");
    panBy(-dx, -dy);
    drag.x = ev.clientX;
    drag.y = ev.clientY;
  });
  const endDrag = (ev) => {
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinch = null;
    if (!drag || ev.pointerId !== drag.id) return;
    container.classList.remove("map-dragging");
    if (!drag.moved && ev.type === "pointerup") {
      const r = container.getBoundingClientRect();
      const lonLat = unproject(ev.clientX - r.left, ev.clientY - r.top);
      for (const fn of listeners.click) fn(lonLat, ev);
    }
    drag = null;
  };
  container.addEventListener("pointerup", endDrag);
  container.addEventListener("pointercancel", endDrag);

  container.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = container.getBoundingClientRect();
      zoomAround(ev.deltaY < 0 ? 1 : -1, ev.clientX - r.left, ev.clientY - r.top);
    },
    { passive: false },
  );

  container.addEventListener("keydown", (ev) => {
    if (ev.target !== container) return;
    const [w, h] = size();
    const step = 80;
    const keys = {
      ArrowLeft: () => panBy(-step, 0),
      ArrowRight: () => panBy(step, 0),
      ArrowUp: () => panBy(0, -step),
      ArrowDown: () => panBy(0, step),
      "+": () => zoomAround(1, w / 2, h / 2),
      "=": () => zoomAround(1, w / 2, h / 2),
      "-": () => zoomAround(-1, w / 2, h / 2),
      Enter: () => {
        for (const fn of listeners.click) fn(center.slice(), ev);
      },
    };
    if (keys[ev.key]) {
      ev.preventDefault();
      keys[ev.key]();
    }
  });

  new ResizeObserver(onResize).observe(container);

  const api = {
    container,
    panes,
    project,
    unproject,
    setView,
    fitBounds,
    panBy,
    zoomIn: () => zoomAround(1, size()[0] / 2, size()[1] / 2),
    zoomOut: () => zoomAround(-1, size()[0] / 2, size()[1] / 2),
    getZoom: () => zoom,
    getCenter: () => center.slice(),
    size,
    // Stretch an element (img or canvas) over lon/lat bounds in a pane.
    addOverlay(id, el, bounds, paneName = "base") {
      api.removeOverlay(id);
      el.classList.add("map-overlay");
      panes[paneName].append(el);
      overlays.set(id, { el, bounds });
      schedule();
      return el;
    },
    // A second tile source drawn over the basemap and under the site overlays. Returns the layer's
    // element, for a caller that styles or clips it (orbits.js clips the night lights to the night).
    setTileLayer(id, template, { maxZoom: mz = 9, opacity = 0.85, pane: paneName = "live" } = {}) {
      api.removeTileLayer(id);
      const el = document.createElement("div");
      el.className = { live: "map-live-layer", tiles: "map-basemap-layer" }[paneName] ?? "map-label-layer";
      el.style.opacity = String(opacity);
      panes[paneName].append(el);
      // JPEG layers are opaque by format and a black JPEG can be real (night lights), so only PNGs are probed.
      tileLayers.set(id, { template, maxZoom: mz, tiles: new Map(), el, checkFiller: template.endsWith(".png") });
      schedule();
      return el;
    },
    removeTileLayer(id) {
      const layer = tileLayers.get(id);
      if (layer) {
        layer.el.remove();
        tileLayers.delete(id);
      }
    },
    setTileOpacity(id, opacity) {
      const layer = tileLayers.get(id);
      if (layer) layer.el.style.opacity = String(opacity);
    },
    removeOverlay(id) {
      const o = overlays.get(id);
      if (o) {
        o.el.remove();
        overlays.delete(id);
      }
    },
    onRender(fn) {
      renderHooks.add(fn);
      schedule();
      return () => renderHooks.delete(fn);
    },
    on(type, fn) {
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    refresh: schedule,
    // Street tiles on or off (a NASA basemap replaces them); false when started without tiles.
    setStreets(on) {
      streets = Boolean(tileUrl) && on;
      schedule();
    },
    hasStreets: () => Boolean(tileUrl),
    setAttribution(text) {
      if (attributionEl) attributionEl.textContent = text;
    },
  };
  schedule();
  return api;
}
