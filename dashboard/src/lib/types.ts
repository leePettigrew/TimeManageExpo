export interface Profile {
  id: string;
  company_id: string;
  role: 'manager' | 'worker';
  full_name: string;
  phone_e164: string;
  is_active: boolean;
  ping_interval_s: number;
}

export interface LocationRequest {
  id: string;
  company_id: string;
  worker_id: string;
  requested_by: string;
  created_at: string;
  fulfilled_at: string | null;
}

export const PING_INTERVALS: { value: number; label: string }[] = [
  { value: 60, label: 'Every minute' },
  { value: 90, label: 'Every 1.5 min (default)' },
  { value: 180, label: 'Every 3 min' },
  { value: 300, label: 'Every 5 min' },
  { value: 900, label: 'Every 15 min (battery saver)' },
];

export interface Shift {
  id: string;
  company_id: string;
  worker_id: string;
  status: 'open' | 'closed' | 'auto_closed' | 'disputed';
  clock_in_device_at: string;
  clock_in_received_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy_m: number | null;
  clock_in_mocked: boolean;
  clock_out_device_at: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  anomaly_flags: string[];
}

export interface ShiftEffective extends Shift {
  full_name: string;
  effective_clock_in_at: string;
  effective_clock_out_at: string | null;
  worked_seconds: number | null;
  is_adjusted: boolean;
  is_flagged: boolean;
  clock_in_sync_lag_s: number;
}

export interface LatestPing {
  worker_id: string;
  company_id: string;
  shift_id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  mocked: boolean;
  battery_pct: number | null;
  device_at: string;
  received_at: string;
}

export interface Ping {
  id: number;
  shift_id: string;
  seq: number;
  device_at: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  mocked: boolean;
}

export interface TimesheetWeekly {
  company_id: string;
  worker_id: string;
  full_name: string;
  iso_year: number;
  iso_week: number;
  week_starts: string;
  shift_count: number;
  worked_seconds: number | null;
  worked_hours: number | null;
  flagged_shifts: number;
  has_adjustments: boolean;
}

export interface TimesheetDaily {
  company_id: string;
  worker_id: string;
  full_name: string;
  work_date: string;
  shift_count: number;
  worked_seconds: number | null;
  worked_hours: number | null;
  flagged_shifts: number;
  open_shifts: number;
  has_adjustments: boolean;
}

export const FLAG_LABELS: Record<string, string> = {
  mock_location: 'Fake GPS suspected',
  missing_gps: 'No GPS at clock event',
  low_accuracy: 'Poor GPS accuracy',
  late_sync: 'Synced long after the event',
  time_anomaly: 'Clock-out before clock-in',
  ping_gap: 'Tracking went silent mid-shift',
  auto_closed_no_clock_out: 'Never clocked out (auto-closed)',
  impossible_speed: 'Impossible travel speed',
  suspicious_accuracy: 'GPS accuracy looks fabricated',
};
