// LocationService: single interface for GPS capture so the implementation can
// be swapped (expo-location now; Transistorsoft later if OEM kill-rates in the
// field demand it). M1 uses foreground fixes at clock events; M3 adds the
// background breadcrumb task.
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  mocked: boolean;
  batteryPct: number | null;
  deviceAt: Date;
}

export async function requestForegroundPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

/**
 * One quick fix for a clock event. Never blocks a clock-in on GPS: on timeout,
 * denial, or airplane mode it returns null and the event is stored with a
 * missing_gps flag server-side — honesty over friction.
 */
export async function getFix(timeoutMs = 12_000): Promise<Fix | null> {
  try {
    const granted = await requestForegroundPermission();
    if (!granted) return null;

    const pos = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      timeoutMs,
    );
    if (!pos) return null;

    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? null,
      mocked: pos.mocked ?? false,
      batteryPct: await batteryPct(),
      deviceAt: new Date(pos.timestamp),
    };
  } catch {
    return null;
  }
}

/**
 * A fix suitable for BACKGROUND use (e.g. answering a locate push). A one-shot
 * getCurrentPositionAsync typically never resolves while the app is
 * backgrounded, so prefer the OS's last-known position (which returns
 * immediately, backgrounded or not) and only fall back to a live request.
 */
export async function getBackgroundFix(maxAgeMs = 120_000): Promise<Fix | null> {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    if (last) {
      return {
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        accuracyM: last.coords.accuracy ?? null,
        mocked: last.mocked ?? false,
        batteryPct: await batteryPct(),
        deviceAt: new Date(last.timestamp),
      };
    }
  } catch {
    /* fall through to a live request */
  }
  return getFix(10_000);
}

export async function batteryPct(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.round(level * 100) : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}
