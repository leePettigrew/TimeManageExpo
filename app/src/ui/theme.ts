// Design system. Built for site conditions — big touch targets, high contrast
// in sunlight — but with a modern, calm look: deep navy surfaces, soft
// borders, one confident green.
export const colors = {
  bg: '#0B1220',
  card: '#131D30',
  cardHi: '#1A2740',
  border: '#233150',
  text: '#F2F6FC',
  textDim: '#8DA2BD',
  textFaint: '#5C7089',
  primary: '#4ADE80',
  primaryDim: 'rgba(74, 222, 128, 0.14)',
  onPrimary: '#052012',
  danger: '#F87171',
  dangerDim: 'rgba(248, 113, 113, 0.14)',
  warn: '#FBBF24',
  warnDim: 'rgba(251, 191, 36, 0.14)',
  info: '#60A5FA',
  infoDim: 'rgba(96, 165, 250, 0.14)',
};

export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  pill: 999,
};

export const spacing = (n: number) => n * 8;

export const type = {
  title: { fontSize: 28, fontWeight: '800' as const, color: colors.text, letterSpacing: -0.5 },
  h2: { fontSize: 19, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 16, color: colors.text, lineHeight: 23 },
  small: { fontSize: 13, color: colors.textDim },
};
