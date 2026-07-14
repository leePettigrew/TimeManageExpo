// MapLibre map: live worker markers + optional breadcrumb trail for one shift.
// Tiles come from the style URL in env — swap that one value to change
// provider (OpenFreeMap → MapTiler/Protomaps) with zero code changes.
import { useEffect, useRef } from 'react';
import maplibregl, { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_STYLE_URL } from '../lib/supabase';
import type { LatestPing, Ping } from '../lib/types';
import { fmtAgo } from '../lib/format';

const DUBLIN: [number, number] = [-6.2603, 53.3498];
const TRAIL_SOURCE = 'trail';

interface Props {
  latest: (LatestPing & { name: string; stale: boolean })[];
  trail: Ping[] | null;
  focusWorkerId: string | null;
  onSelectWorker: (workerId: string) => void;
}

export function WorkerMap({ latest, trail, focusWorkerId, onSelectWorker }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<Record<string, Marker>>({});
  const loaded = useRef(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: DUBLIN,
      zoom: 10,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    m.on('load', () => {
      loaded.current = true;
      m.addSource(TRAIL_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addLayer({
        id: 'trail-line',
        type: 'line',
        source: TRAIL_SOURCE,
        paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'trail-points',
        type: 'circle',
        source: TRAIL_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': ['case', ['get', 'mocked'], '#ef4444', '#38bdf8'],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0f172a',
        },
      });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      loaded.current = false;
    };
  }, []);

  // markers for latest positions
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const p of latest) {
      seen.add(p.worker_id);
      const existing = markers.current[p.worker_id];
      if (existing) {
        existing.setLngLat([p.lng, p.lat]);
        const el = existing.getElement();
        el.classList.toggle('marker-stale', p.stale);
        el.title = `${p.name} — ${fmtAgo(p.received_at)}`;
      } else {
        const el = document.createElement('div');
        el.className = 'worker-marker' + (p.stale ? ' marker-stale' : '');
        el.textContent = initials(p.name);
        el.title = `${p.name} — ${fmtAgo(p.received_at)}`;
        el.addEventListener('click', () => onSelectWorker(p.worker_id));
        markers.current[p.worker_id] = new maplibregl.Marker({ element: el })
          .setLngLat([p.lng, p.lat])
          .addTo(m);
      }
    }
    for (const [id, marker] of Object.entries(markers.current)) {
      if (!seen.has(id)) {
        marker.remove();
        delete markers.current[id];
      }
    }
  }, [latest, onSelectWorker]);

  // focus a worker
  useEffect(() => {
    const m = map.current;
    if (!m || !focusWorkerId) return;
    const p = latest.find((x) => x.worker_id === focusWorkerId);
    if (p) m.flyTo({ center: [p.lng, p.lat], zoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusWorkerId]);

  // breadcrumb trail
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded.current) return;
    const src = m.getSource(TRAIL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!trail || trail.length === 0) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const coords = trail.map((p) => [p.lng, p.lat] as [number, number]);
    src.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} },
        ...trail.map((p) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          properties: { mocked: p.mocked },
        })),
      ],
    });
    if (coords.length > 1) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      m.fitBounds(bounds, { padding: 60, maxZoom: 15 });
    }
  }, [trail]);

  return <div ref={container} className="map" />;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  );
}
