// Shift replay: the "prove it" view. Draws one shift's full breadcrumb route
// on a map with start/end pins and a timeline, in a modal.
import { useEffect, useRef } from 'react';
import maplibregl, { Map as MlMap } from 'maplibre-gl';
import { useQuery } from '@tanstack/react-query';
import { supabase, MAP_STYLE_URL } from '../lib/supabase';
import type { Ping, ShiftEffective } from '../lib/types';
import { fmtDate, fmtHours, fmtTime } from '../lib/format';

export function ShiftReplay({ shift, onClose }: { shift: ShiftEffective; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);

  const trail = useQuery({
    queryKey: ['replay', shift.id],
    queryFn: async (): Promise<Ping[]> => {
      const { data, error } = await supabase
        .from('location_pings')
        .select('id, shift_id, seq, device_at, lat, lng, accuracy_m, mocked')
        .eq('shift_id', shift.id)
        .order('device_at', { ascending: true })
        .limit(3000);
      if (error) throw error;
      return data as Ping[];
    },
  });

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: [-6.26, 53.35],
      zoom: 11,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const points = trail.data;
    if (!m || !points) return;

    const draw = () => {
      const line = points.map((p) => [p.lng, p.lat] as [number, number]);

      if (m.getSource('replay')) (m.getSource('replay') as maplibregl.GeoJSONSource).setData(fc(points));
      else {
        m.addSource('replay', { type: 'geojson', data: fc(points) });
        m.addLayer({
          id: 'replay-line',
          type: 'line',
          source: 'replay',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#60A5FA', 'line-width': 3.5, 'line-opacity': 0.9 },
        });
        m.addLayer({
          id: 'replay-pts',
          type: 'circle',
          source: 'replay',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': ['case', ['get', 'mocked'], '#F87171', '#60A5FA'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#0B1220',
          },
        });

        // click a breadcrumb to see the exact time it was recorded
        m.on('click', 'replay-pts', (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as { device_at: string; accuracy_m: number | null; seq: number; mocked: boolean };
          const t = new Date(p.device_at);
          const when = t.toLocaleString('en-IE', {
            weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          const acc = p.accuracy_m != null ? ` · ±${Math.round(p.accuracy_m)}m` : '';
          const mock = p.mocked ? '<br/><b style="color:#F87171">⚠ fake GPS suspected</b>' : '';
          new maplibregl.Popup({ closeButton: false, offset: 8 })
            .setLngLat((f.geometry as { coordinates: [number, number] }).coordinates)
            .setHTML(
              `<div style="font:13px system-ui;color:#0B1220"><b>${when}</b><br/>point #${p.seq}${acc}${mock}</div>`,
            )
            .addTo(m);
        });
        m.on('mouseenter', 'replay-pts', () => { m.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', 'replay-pts', () => { m.getCanvas().style.cursor = ''; });
      }

      // start/end markers
      if (line.length > 0) {
        addPin(m, 'start', line[0], '#4ADE80');
        addPin(m, 'end', line[line.length - 1], '#F87171');
        const b = line.reduce(
          (acc, c) => acc.extend(c),
          new maplibregl.LngLatBounds(line[0], line[0]),
        );
        m.fitBounds(b, { padding: 50, maxZoom: 15, duration: 0 });
      }
    };

    if (m.isStyleLoaded()) draw();
    else m.once('load', draw);
  }, [trail.data]);

  const points = trail.data ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>
            {shift.full_name} — {fmtDate(shift.effective_clock_in_at)}
          </h2>
          <span className="spacer" />
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="stat-row" style={{ marginBottom: 12 }}>
          <div className="stat">
            <div className="k">Clocked in</div>
            <div className="v" style={{ fontSize: 22 }}>{fmtTime(shift.effective_clock_in_at)}</div>
          </div>
          <div className="stat">
            <div className="k">Clocked out</div>
            <div className="v" style={{ fontSize: 22 }}>
              {shift.status === 'open' ? 'still on' : fmtTime(shift.effective_clock_out_at)}
            </div>
          </div>
          <div className="stat">
            <div className="k">Worked</div>
            <div className="v green" style={{ fontSize: 22 }}>{fmtHours(shift.worked_seconds)}</div>
          </div>
          <div className="stat">
            <div className="k">GPS points</div>
            <div className="v" style={{ fontSize: 22 }}>{points.length}</div>
          </div>
        </div>
        <div className="replay-map" ref={container} />
        {trail.isLoading ? (
          <p className="dim small">Loading route…</p>
        ) : points.length === 0 ? (
          <p className="dim small">
            No breadcrumbs recorded for this shift (tracking may have been off or denied).
          </p>
        ) : (
          <p className="dim small">
            🟢 start · 🔴 end · red dots are suspected fake-GPS points ·{' '}
            <b>click any point to see its exact time</b>.
          </p>
        )}
      </div>
    </div>
  );
}

function fc(points: Ping[]) {
  const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
  return {
    type: 'FeatureCollection' as const,
    features: [
      { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} },
      ...points.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: {
          mocked: p.mocked,
          device_at: p.device_at,
          accuracy_m: p.accuracy_m,
          seq: p.seq,
        },
      })),
    ],
  };
}

const pins: Record<string, maplibregl.Marker> = {};
function addPin(m: MlMap, key: string, at: [number, number], color: string) {
  pins[key]?.remove();
  const el = document.createElement('div');
  el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.6)`;
  pins[key] = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(m);
}
