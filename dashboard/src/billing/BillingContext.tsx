import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchMyCompany, type MyCompany } from './billing';

interface BillingCtx {
  company: MyCompany | null;
  loading: boolean;
  isActive: boolean; // trial valid or subscribed
  readOnly: boolean; // !isActive → managers can view but not mutate
  refresh: () => Promise<void>;
}

const Ctx = createContext<BillingCtx | null>(null);

export function BillingProvider({ children }: { children: ReactNode }) {
  const [company, setCompany] = useState<MyCompany | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setCompany(await fetchMyCompany());
    } catch {
      /* keep last value */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo<BillingCtx>(() => {
    const isActive = company?.is_active ?? true; // optimistic until loaded
    return { company, loading, isActive, readOnly: !isActive, refresh };
  }, [company, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBilling(): BillingCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBilling outside BillingProvider');
  return c;
}
