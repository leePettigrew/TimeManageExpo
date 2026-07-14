import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);

export const MAP_STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string) ??
  'https://tiles.openfreemap.org/styles/liberty';
