// Minimal inline icon set (stroke style, 24x24 grid). Avoids an icon-font
// dependency and keeps the bundle self-contained.
type IconName =
  | 'live'
  | 'timesheet'
  | 'review'
  | 'team'
  | 'admin'
  | 'signout'
  | 'search'
  | 'pin'
  | 'download'
  | 'chevron-left'
  | 'chevron-right'
  | 'battery'
  | 'clock';

const PATHS: Record<IconName, string> = {
  live: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 7v5l3 2',
  timesheet: 'M4 4h16v16H4zM8 4v16M4 9h4M4 14h4',
  review: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4',
  team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.7M21 21v-1a6 6 0 0 0-4-5.6',
  admin: 'M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z',
  signout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  battery: 'M3 8h14v8H3zM17 11h2v2h-2',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 7v5l3 2',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
