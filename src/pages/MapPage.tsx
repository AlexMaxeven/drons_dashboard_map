import maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { DemoFleetUpdate } from '../demo/realtime/demoFleet.worker';
import { useFleet } from '../fleet/FleetContext';

const KYIV = { lng: 30.5238, lat: 50.4547 };
const SOURCE_ID = 'demo-fleet';
const UNCLUSTERED_LAYER_ID = 'demo-fleet-unclustered';
const ROUTE_SOURCE_ID = 'demo-fleet-route';
const ROUTE_LAYER_ID = 'demo-fleet-route-line';

type MapStyleId = 'vector_demo' | 'osm_raster' | 'esri_satellite';

type RenderUpdate = DemoFleetUpdate & {
  missing: boolean;
  blink: number; // 0..1 (only meaningful when missing)
};

const MISSING_BLINK_SHOW_MS = 25_000; // blink for this long, then hide (until it "reappears" later)
const MISSING_BLINK_PERIOD_MS = 750;
/** Popup anchor + live stats (not the route button) — avoids pixel-chasing every tick. */
const POPUP_UI_INTERVAL_MS = 320;

/** Tooltip only (short) — no long copy in panel/popup body. */
const ROUTE_NO_TRACK_TOOLTIP_UA = 'Трек лише у частини дронів (демо). Не помилка.';

/** Only the block that changes every tick — updated in RAF without touching the route button DOM. */
function renderPopupLiveHtml(u: DemoFleetUpdate): string {
  const missingReason = u.missingReason ?? '';
  return `Status: <b>${u.state === 'missing' ? 'missing' : 'active'}</b>${missingReason ? ` (${missingReason})` : ''}<br/>
      Speed: <b>${u.speedKmh.toFixed(1)}</b> km/h<br/>
      Region: <b>${u.region || '—'}</b><br/>
      Flight time: <b>${u.flightMin}</b> min<br/>
      Endurance: <b>${u.enduranceMinLeft}</b> / ${u.enduranceMinTotal} min left<br/>
      Updated: ${new Date(u.ts).toLocaleTimeString()}`;
}

function renderPopupHtml(u: DemoFleetUpdate, opts: { routeShown: boolean; hasRoute: boolean }) {
  const kind = u.kind;
  const id = u.id;
  const routeAttrId = encodeURIComponent(id);
  const disabledAttr = opts.hasRoute ? '' : ' disabled';
  const titleAttr = opts.hasRoute ? '' : ` title="${ROUTE_NO_TRACK_TOOLTIP_UA.replace(/"/g, '&quot;')}"`;

  const routeBtn = `<button type="button" class="btn btn-sm btn-outline-warning w-100 mt-2 fleet-route-btn"${disabledAttr}${titleAttr} data-fleet-route-toggle data-vehicle-id="${routeAttrId}" style="min-height:44px;padding:10px 14px;font-size:14px;touch-action:manipulation">${
    opts.routeShown ? 'Сховати маршрут' : 'Маршрут'
  }</button>`;

  return `<div class="fleet-popup-inner" style="min-width:220px;position:relative;z-index:1;pointer-events:auto">
    <div style="font-weight:600">${id}</div>
    <div style="font-size:12px;color:#6c757d">Type: ${kind}</div>
    <div data-fleet-popup-live style="margin-top:6px;font-size:13px">${renderPopupLiveHtml(u)}</div>
    ${routeBtn}
  </div>`;
}

/** MapLibre replaces popup HTML often; wire the button directly so clicks are not lost to the map canvas. */
function wireFleetRouteToggleButton(popup: maplibregl.Popup, onToggle: (vehicleId: string) => void) {
  const bind = () => {
    const root = popup.getElement();
    if (!root) return;
    const btn = root.querySelector<HTMLButtonElement>('[data-fleet-route-toggle]');
    if (!btn) return;
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      const raw = btn.getAttribute('data-vehicle-id');
      const id = raw ? decodeURIComponent(raw) : '';
      if (id) onToggle(id);
    };
    btn.onpointerdown = (e) => {
      e.stopPropagation();
    };
  };
  queueMicrotask(bind);
}

type PopupThrottleState = { lastMs: number; force: boolean };

/** Throttled: anchor + live stats only. Never touches the route button (stable hit target). */
function syncFleetPopupStatsThrottled(
  popup: maplibregl.Popup,
  latest: DemoFleetUpdate,
  throttle: PopupThrottleState,
  nowMs: number,
) {
  const due = throttle.force || nowMs - throttle.lastMs >= POPUP_UI_INTERVAL_MS;
  if (!due) return;
  throttle.force = false;
  throttle.lastMs = nowMs;
  popup.setLngLat([latest.lng, latest.lat]);
  const root = popup.getElement();
  const live = root?.querySelector('[data-fleet-popup-live]');
  if (live) live.innerHTML = renderPopupLiveHtml(latest);
}

function getStyleSpec(styleId: MapStyleId): maplibregl.StyleSpecification | string {
  if (styleId === 'vector_demo') return 'https://demotiles.maplibre.org/style.json';

  if (styleId === 'osm_raster') {
    return {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution:
            '© OpenStreetMap contributors',
        },
      },
      layers: [
        {
          id: 'osm',
          type: 'raster',
          source: 'osm',
        },
      ],
    };
  }

  // Public raster tiles; good for demos. (Note: always respect provider terms for production use.)
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      esri: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Tiles © Esri',
      },
    },
    layers: [
      {
        id: 'esri',
        type: 'raster',
        source: 'esri',
      },
    ],
  };
}

function toFeatureCollection(updates: RenderUpdate[]) {
  return {
    type: 'FeatureCollection' as const,
    features: updates.map((u) => ({
      type: 'Feature' as const,
      id: u.id,
      properties: {
        id: u.id,
        kind: u.kind,
        headingDeg: u.headingDeg,
        speedKmh: u.speedKmh,
        enduranceMinTotal: u.enduranceMinTotal,
        enduranceMinLeft: u.enduranceMinLeft,
        state: u.state,
        missingReason: u.missingReason ?? '',
        missingSinceTs: u.missingSinceTs ?? 0,
        blinkOffsetMs: u.blinkOffsetMs ?? 0,
        missing: u.missing,
        blink: u.blink,
        ts: u.ts,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [u.lng, u.lat] as [number, number],
      },
    })),
  };
}

function ensureRouteLayer(map: maplibregl.Map) {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getLayer(ROUTE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#ffc107',
        'line-width': 3,
        'line-opacity': 0.92,
      },
    });
  }
}

function ensureFleetLayer(map: maplibregl.Map) {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  if (!map.getLayer(UNCLUSTERED_LAYER_ID)) {
    map.addLayer({
      id: UNCLUSTERED_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-radius': [
          'match',
          ['get', 'kind'],
          'fpv',
          4,
          'bomber',
          6,
          'fixedWing',
          5,
          'mavic',
          5,
          5,
        ],
        'circle-color': [
          'match',
          ['get', 'kind'],
          'fpv',
          '#dc3545', // red
          'bomber',
          '#fd7e14', // orange
          'fixedWing',
          '#0d6efd', // blue
          'mavic',
          '#198754', // green
          '#6c757d',
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': ['case', ['boolean', ['get', 'missing'], false], '#ffc107', '#ffffff'],
        // When missing, blink opacity (data-driven; updated on ticks), otherwise normal.
        'circle-opacity': ['case', ['boolean', ['get', 'missing'], false], ['get', 'blink'], 0.92],
        'circle-radius-transition': { duration: 0, delay: 0 },
        'circle-opacity-transition': { duration: 0, delay: 0 },
      },
    });
  }
}

export function MapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const {
    running,
    setRunning,
    desiredVehicles,
    vehicles,
    setDesiredVehicles,
    desiredTicksPerSecond,
    ticksPerSecond,
    setDesiredTicksPerSecond,
    enabledKinds,
    setEnabledKinds,
    pendingRestart,
    applyPendingConfig,
    lastTickTs,
    eventsPerSecond,
    updates,
    updatesById,
    selectedId,
    setSelectedId,
  } = useFleet();

  const updatesByIdRef = useRef(updatesById);
  updatesByIdRef.current = updatesById;

  const [routeOverlayId, setRouteOverlayId] = useState<string | null>(null);
  const routeOverlayIdRef = useRef<string | null>(null);
  routeOverlayIdRef.current = routeOverlayId;

  const routeToggleHandlerRef = useRef<(id: string) => void>(() => {});
  routeToggleHandlerRef.current = (id) => setRouteOverlayId((prev) => (prev === id ? null : id));

  const [styleId, setStyleId] = useState<MapStyleId>('esri_satellite');
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [followSelected, setFollowSelected] = useState(true);
  const [startBlink, setStartBlink] = useState(false);

  const pendingUpdatesRef = useRef<RenderUpdate[] | null>(null);
  const lastRenderedUpdatesRef = useRef<RenderUpdate[] | null>(null);
  const rafRef = useRef<number | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const selectedLatestRef = useRef<DemoFleetUpdate | null>(null);
  const epsWindowRef = useRef<{ t0: number; events: number }>({ t0: performance.now(), events: 0 });
  const styleButtonRef = useRef<HTMLButtonElement | null>(null);
  const styleMenuRef = useRef<HTMLDivElement | null>(null);
  const popupUiThrottleRef = useRef<PopupThrottleState>({ lastMs: 0, force: true });

  const rendered = useMemo<RenderUpdate[]>(() => {
    const nowTs = Date.now();
    const out: RenderUpdate[] = [];
    for (const u of updates) {
      if (u.state !== 'missing') {
        out.push({ ...u, missing: false, blink: 1 });
        continue;
      }
      const missingSince = u.missingSinceTs ?? nowTs;
      const missingAge = nowTs - missingSince;
      if (missingAge > MISSING_BLINK_SHOW_MS) continue;
      const phase =
        (2 * Math.PI * ((nowTs + (u.blinkOffsetMs ?? 0)) % MISSING_BLINK_PERIOD_MS)) / MISSING_BLINK_PERIOD_MS;
      const blink = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(phase));
      out.push({ ...u, missing: true, blink });
    }
    return out;
  }, [updates]);

  useEffect(() => {
    if (!styleMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (styleButtonRef.current?.contains(t)) return;
      if (styleMenuRef.current?.contains(t)) return;
      setStyleMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStyleMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as AddEventListenerOptions);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [styleMenuOpen]);

  useEffect(() => {
    setRouteOverlayId(null);
  }, [selectedId]);

  useEffect(() => {
    popupUiThrottleRef.current = { lastMs: 0, force: true };
  }, [selectedId]);

  /** Route button lives outside the throttled block — only this effect mutates label/disabled. */
  useEffect(() => {
    const popup = popupRef.current;
    if (!popup || !selectedId) return;
    const latest = updatesByIdRef.current.get(selectedId);
    if (!latest) return;
    const root = popup.getElement();
    const btn = root?.querySelector<HTMLButtonElement>('[data-fleet-route-toggle]');
    if (!btn) return;
    const hasRoute = (latest.routePolyline?.length ?? 0) >= 2;
    btn.disabled = !hasRoute;
    if (!hasRoute) {
      btn.setAttribute('title', ROUTE_NO_TRACK_TOOLTIP_UA);
    } else {
      btn.removeAttribute('title');
    }
    btn.textContent = routeOverlayId === selectedId ? 'Сховати маршрут' : 'Маршрут';
  }, [routeOverlayId, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    ensureRouteLayer(map);
    const src = map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!routeOverlayId) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const u = updatesById.get(routeOverlayId);
    const coords = u?.routePolyline;
    if (!coords || coords.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        },
      ],
    });
  }, [routeOverlayId, updatesById, updates]);

  useEffect(() => {
    if (running || !pendingRestart) {
      setStartBlink(false);
      return;
    }
    const id = window.setInterval(() => setStartBlink((v) => !v), 500);
    return () => window.clearInterval(id);
  }, [pendingRestart, running]);

  useEffect(() => {
    const sid = 'fleet-route-popup-style';
    if (document.getElementById(sid)) return;
    const el = document.createElement('style');
    el.id = sid;
    el.textContent = `
.maplibregl-popup.fleet-route-popup{z-index:30!important}
.maplibregl-popup.fleet-route-popup .maplibregl-popup-content{pointer-events:auto!important}

/* Mobile tweaks */
@media (max-width: 991.98px){
  .maplibregl-popup.fleet-route-popup{max-width:min(92vw, 320px)}
  .maplibregl-popup.fleet-route-popup .maplibregl-popup-content{padding:10px 10px!important}
  .maplibregl-popup.fleet-route-popup .fleet-route-btn{min-height:40px!important;padding:8px 12px!important}
}

/* Prevent sidebar overlay on smaller screens (tablet/phone). */
.fleet-map-sidebar{position:relative;z-index:2000;isolation:isolate}
@media (max-width: 1199.98px){
  .fleet-map-sidebar{z-index:0;isolation:auto}
}
`;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, []);

  // Init the map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getStyleSpec(styleId),
      center: [KYIV.lng, KYIV.lat],
      zoom: 7.8,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      ensureRouteLayer(map);
      ensureFleetLayer(map);
    });

    // When switching styles, all custom sources/layers are dropped — re-add fleet layer.
    map.on('style.load', () => {
      ensureRouteLayer(map);
      ensureFleetLayer(map);
      const updates = lastRenderedUpdatesRef.current ?? pendingUpdatesRef.current;
      if (updates) {
        const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
        src?.setData(toFeatureCollection(updates));
      }
    });

    map.on('click', UNCLUSTERED_LAYER_ID, (ev) => {
      const f = ev.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const props = (f.properties ?? {}) as Record<string, unknown>;

      const kind = String(props.kind ?? 'unknown');
      const speedKmh = Number(props.speedKmh ?? 0);
      const enduranceMinLeft = Number(props.enduranceMinLeft ?? 0);
      const enduranceMinTotal = Number(props.enduranceMinTotal ?? 0);
      const id = String(props.id ?? f.id ?? 'unknown');
      const ts = Number(props.ts ?? Date.now());
      const state = String(props.state ?? 'active');
      const missingReason = String(props.missingReason ?? '');
      const region = String(props.region ?? '');
      const flightMin = Number(props.flightMin ?? 0);

      const fromStore = updatesByIdRef.current.get(id);
      const selectedUpdate: DemoFleetUpdate = fromStore
        ? { ...fromStore, lng: coords[0], lat: coords[1] }
        : {
            id,
            kind: kind as DemoFleetUpdate['kind'],
            region,
            flightMin,
            lng: coords[0],
            lat: coords[1],
            headingDeg: Number(props.headingDeg ?? 0),
            speedKmh,
            enduranceMinLeft,
            enduranceMinTotal,
            state: state as DemoFleetUpdate['state'],
            missingReason: missingReason ? (missingReason as DemoFleetUpdate['missingReason']) : null,
            missingSinceTs: Number(props.missingSinceTs ?? 0) || null,
            blinkOffsetMs: Number(props.blinkOffsetMs ?? 0) || 0,
            ts,
          };
      setSelectedId(selectedUpdate.id);
      selectedLatestRef.current = selectedUpdate;

      if (!popupRef.current) {
        popupRef.current = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: '260px',
          className: 'fleet-route-popup',
        });
      }
      const hasRoute = (selectedUpdate.routePolyline?.length ?? 0) >= 2;
      popupRef.current
        .setLngLat(coords)
        .setHTML(
          renderPopupHtml(selectedUpdate, {
            routeShown: routeOverlayIdRef.current === selectedUpdate.id,
            hasRoute,
          }),
        )
        .addTo(map);
      wireFleetRouteToggleButton(popupRef.current, (id) => routeToggleHandlerRef.current(id));
    });

    // Click on empty map closes popup.
    map.on('click', (ev) => {
      const features = map.queryRenderedFeatures(ev.point, { layers: [UNCLUSTERED_LAYER_ID] });
      if (features.length > 0) return;
      popupRef.current?.remove();
      setSelectedId(null);
      selectedLatestRef.current = null;
    });

    map.on('mouseenter', UNCLUSTERED_LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', UNCLUSTERED_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Update style without recreating the map instance
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(getStyleSpec(styleId));
  }, [styleId]);

  // Push rendered data to the map (RAF-batched).
  useEffect(() => {
    pendingUpdatesRef.current = rendered;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const map = mapRef.current;
      const updatesToRender = pendingUpdatesRef.current;
      pendingUpdatesRef.current = null;
      if (!map || !updatesToRender) return;
      if (!map.isStyleLoaded()) return;
      ensureRouteLayer(map);
      ensureFleetLayer(map);
      const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      src?.setData(toFeatureCollection(updatesToRender));
      lastRenderedUpdatesRef.current = updatesToRender;

      if (!selectedId) return;
      const latest = updatesById.get(selectedId) ?? null;
      if (!latest) return;
      selectedLatestRef.current = latest;
      if (popupRef.current) {
        const th = popupUiThrottleRef.current;
        syncFleetPopupStatsThrottled(popupRef.current, latest, th, performance.now());
      }
      if (followSelected) {
        map.setCenter([latest.lng, latest.lat], { essential: true });
      }
    });
  }, [rendered, followSelected, selectedId, updatesById]);

  // When coming from Dashboard: open popup immediately for the selected drone.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const latest = updatesById.get(selectedId) ?? null;
    if (!latest) return;
    selectedLatestRef.current = latest;

    if (!popupRef.current) {
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: '260px',
        className: 'fleet-route-popup',
      });
    }

    const hasRoute = (latest.routePolyline?.length ?? 0) >= 2;
    popupRef.current
      .setLngLat([latest.lng, latest.lat])
      .setHTML(
        renderPopupHtml(latest, {
          routeShown: routeOverlayIdRef.current === latest.id,
          hasRoute,
        }),
      )
      .addTo(map);
    wireFleetRouteToggleButton(popupRef.current, (id) => routeToggleHandlerRef.current(id));
    if (followSelected) {
      map.easeTo({ center: [latest.lng, latest.lat], zoom: Math.max(map.getZoom(), 9), duration: 450, essential: true });
    }
  }, [followSelected, selectedId, updatesById]);

  // If filters change, re-apply them to the latest known updates.
  useEffect(() => {
    const map = mapRef.current;
    const updates = pendingUpdatesRef.current;
    if (!map || !updates || !map.isStyleLoaded()) return;
    ensureRouteLayer(map);
    ensureFleetLayer(map);
    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    src?.setData(toFeatureCollection(updates.filter((u) => enabledKinds[u.kind])));
  }, [enabledKinds]);

  // Follow is handled in the render RAF loop to avoid frequent React re-renders.

  return (
    <div className="row g-3">
      <div
        className="col-12 col-xl-4 fleet-map-sidebar"
      >
        <div className="card">
          <div className="card-body">
            <div className="d-flex align-items-center justify-content-between gap-2">
              <h5 className="card-title mb-0">Live demo (no backend)</h5>
              <span className={running ? 'badge text-bg-success' : 'badge text-bg-secondary'}>
                {running ? 'Running' : 'Stopped'}
              </span>
            </div>

            <div className="mt-3" style={{ position: 'relative', zIndex: 2100 }}>
              <label className="form-label">Map style</label>
              <div className="position-relative">
                <button
                  ref={styleButtonRef}
                  type="button"
                  className="btn btn-outline-secondary w-100 d-flex align-items-center justify-content-between"
                  onClick={() => setStyleMenuOpen((v) => !v)}
                >
                  <span>
                    {styleId === 'esri_satellite'
                      ? 'Satellite'
                      : styleId === 'osm_raster'
                        ? 'Streets (OSM raster)'
                        : 'Streets (vector demo)'}
                  </span>
                  <span className="text-muted">▾</span>
                </button>

                {styleMenuOpen ? (
                  <div
                    ref={styleMenuRef}
                    className="list-group position-absolute w-100 shadow"
                    style={{ top: 'calc(100% + 6px)', left: 0, zIndex: 2200 }}
                    role="menu"
                  >
                    <button
                      type="button"
                      className={`list-group-item list-group-item-action ${styleId === 'esri_satellite' ? 'active' : ''}`}
                      onClick={() => {
                        setStyleId('esri_satellite');
                        setStyleMenuOpen(false);
                      }}
                    >
                      Satellite
                    </button>
                    <button
                      type="button"
                      className={`list-group-item list-group-item-action ${styleId === 'osm_raster' ? 'active' : ''}`}
                      onClick={() => {
                        setStyleId('osm_raster');
                        setStyleMenuOpen(false);
                      }}
                    >
                      Streets (OSM raster)
                    </button>
                    <button
                      type="button"
                      className={`list-group-item list-group-item-action ${styleId === 'vector_demo' ? 'active' : ''}`}
                      onClick={() => {
                        setStyleId('vector_demo');
                        setStyleMenuOpen(false);
                      }}
                    >
                      Streets (vector demo)
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-3">
              <div className="d-flex align-items-center justify-content-between">
                <div className="fw-semibold">Legend</div>
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="followSwitch"
                    checked={followSelected}
                    onChange={(e) => setFollowSelected(e.target.checked)}
                    disabled={!selectedId}
                  />
                  <label className="form-check-label" htmlFor="followSwitch">
                    Follow selected
                  </label>
                </div>
              </div>
              <div className="mt-2 d-flex flex-column gap-1 small">
                <label className="d-flex align-items-center gap-2">
                  <input
                    className="form-check-input m-0"
                    type="checkbox"
                    checked={enabledKinds.fpv}
                    onChange={(e) => setEnabledKinds((s) => ({ ...s, fpv: e.target.checked }))}
                  />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: '#dc3545', display: 'inline-block' }} />
                  FPV (fast, ~15 min)
                </label>
                <label className="d-flex align-items-center gap-2">
                  <input
                    className="form-check-input m-0"
                    type="checkbox"
                    checked={enabledKinds.bomber}
                    onChange={(e) => setEnabledKinds((s) => ({ ...s, bomber: e.target.checked }))}
                  />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: '#fd7e14', display: 'inline-block' }} />
                  Bomber (bigger, fast, ~15 min)
                </label>
                <label className="d-flex align-items-center gap-2">
                  <input
                    className="form-check-input m-0"
                    type="checkbox"
                    checked={enabledKinds.fixedWing}
                    onChange={(e) => setEnabledKinds((s) => ({ ...s, fixedWing: e.target.checked }))}
                  />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: '#0d6efd', display: 'inline-block' }} />
                  Fixed‑wing (slow, long endurance, can loiter)
                </label>
                <label className="d-flex align-items-center gap-2">
                  <input
                    className="form-check-input m-0"
                    type="checkbox"
                    checked={enabledKinds.mavic}
                    onChange={(e) => setEnabledKinds((s) => ({ ...s, mavic: e.target.checked }))}
                  />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: '#198754', display: 'inline-block' }} />
                  Mavic (slow, hovers often)
                </label>
              </div>
              {selectedId ? (
                <div className="mt-2">
                  <div className="small text-muted">
                    Selected: <span className="fw-semibold text-body">{selectedId}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-warning w-100 mt-2"
                    style={{ minHeight: 44, touchAction: 'manipulation' }}
                    disabled={(updatesById.get(selectedId)?.routePolyline?.length ?? 0) < 2}
                    title={
                      (updatesById.get(selectedId)?.routePolyline?.length ?? 0) < 2
                        ? ROUTE_NO_TRACK_TOOLTIP_UA
                        : undefined
                    }
                    onClick={() => setRouteOverlayId((p) => (p === selectedId ? null : selectedId))}
                  >
                    {routeOverlayId === selectedId ? 'Сховати маршрут' : 'Маршрут'}
                  </button>
                </div>
              ) : (
                <div className="mt-2 small text-muted">
                  Click a point on the map to select it.
                </div>
              )}
            </div>

            <div className="mt-3">
              <div className="d-flex gap-2 flex-wrap">
                <button
                  className={
                    running
                      ? pendingRestart
                        ? startBlink
                          ? 'btn btn-warning'
                          : 'btn btn-outline-warning'
                        : 'btn btn-primary'
                      : pendingRestart
                        ? startBlink
                          ? 'btn btn-warning'
                          : 'btn btn-outline-warning'
                        : 'btn btn-primary'
                  }
                  onClick={() => {
                    applyPendingConfig();
                    setRunning(true);
                  }}
                  disabled={running && !pendingRestart}
                >
                  {running ? (pendingRestart ? 'Apply' : 'Start') : 'Start'}
                </button>
                <button className="btn btn-outline-secondary" onClick={() => setRunning(false)} disabled={!running}>
                  Stop
                </button>
              </div>
              {!running && pendingRestart ? (
                <div className="form-text mt-2">Config changed. Press Start to apply.</div>
              ) : null}
            </div>

            <div className="mt-3">
              <label className="form-label">
                Vehicles: {desiredVehicles.toLocaleString()}
                {pendingRestart ? (
                  <span className="text-muted small">
                    {' '}
                    (active: {vehicles.toLocaleString()})
                  </span>
                ) : null}
              </label>
              <input
                className="form-range"
                type="range"
                min={10}
                max={2000}
                step={10}
                value={desiredVehicles}
                onChange={(e) => setDesiredVehicles(Number(e.target.value))}
              />
            </div>

            <div className="mt-3">
              <label className="form-label">
                Ticks / second: {running ? ticksPerSecond : desiredTicksPerSecond}
                {!running && pendingRestart ? <span className="text-warning-emphasis"> (pending)</span> : null}
              </label>
              <input
                className="form-range"
                type="range"
                min={1}
                max={30}
                step={1}
                value={running ? ticksPerSecond : desiredTicksPerSecond}
                onChange={(e) => setDesiredTicksPerSecond(Number(e.target.value))}
              />
              <div className="form-text">
                We throttle map updates to animation frames so the UI stays responsive even under load.
              </div>
            </div>

            <div className="mt-3">
              <div className="small text-muted">
                Events/sec: <span className="fw-semibold text-body">{eventsPerSecond.toLocaleString()}</span>
              </div>
              <div className="small text-muted">
                Last tick:{' '}
                <span className="fw-semibold text-body">
                  {lastTickTs ? new Date(lastTickTs).toLocaleTimeString() : '—'}
                </span>
              </div>
            </div>

            <hr />
            <div className="form-text">
              Next: KMZ/KML import → GeoJSON, clustering, and optional Live mode via WebSocket.
            </div>
          </div>
        </div>
      </div>
      <div className="col-12 col-xl-8" style={{ position: 'relative', zIndex: 1 }}>
        <div className="card">
          <div className="card-body p-0">
            <div
              ref={containerRef}
              style={{
                // Desktop stays 680px; mobile uses viewport height so it doesn't overflow.
                height: 'min(680px, calc(100dvh - 220px))',
                minHeight: 360,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

