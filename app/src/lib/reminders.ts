// Local "still clocked in?" reminder. A notification fires N hours after
// clock-in unless the worker clocks out first. Entirely on-device — no server,
// no push infrastructure — so it works offline too.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const REMINDER_AFTER_HOURS = 10;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let reminderId: string | null = null;

export async function ensureNotificationSetup(): Promise<void> {
  try {
    await Notifications.requestPermissionsAsync();
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Shift reminders',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  } catch {
    /* permission denied — reminders simply won't fire */
  }
}

/** Schedule the forgot-to-clock-out nudge. Cancels any previous one first. */
export async function scheduleClockOutReminder(): Promise<void> {
  try {
    await cancelClockOutReminder();
    reminderId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Still on the clock?',
        body: "You've been clocked in a while. Tap to open TimeTable if you forgot to clock out.",
        ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: REMINDER_AFTER_HOURS * 3600,
      },
    });
  } catch {
    /* scheduling unavailable — non-critical */
  }
}

export async function cancelClockOutReminder(): Promise<void> {
  try {
    if (reminderId) {
      await Notifications.cancelScheduledNotificationAsync(reminderId);
      reminderId = null;
    }
    // belt and braces: clear any strays from a previous app run
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    /* ignore */
  }
}
