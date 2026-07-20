import { useState } from 'react';
import { useBilling } from './BillingContext';
import { startCheckout, openPortal, trialDaysLeft } from './billing';

export function BillingPage() {
  const { company, refresh } = useBilling();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!company) return <div className="page">Loading…</div>;

  const status = company.subscription_status;
  const active = company.is_active;
  const priceHint = '€ per active worker / month'; // actual price is set in Stripe

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="stat-row">
        <div className="stat">
          <div className="k">Plan</div>
          <div className="v" style={{ fontSize: 22 }}>
            {status === 'active' ? 'Subscribed' : status === 'trialing' ? 'Free trial' : status}
          </div>
        </div>
        <div className="stat">
          <div className="k">Active workers (billed)</div>
          <div className="v">{company.active_workers}</div>
        </div>
        <div className="stat">
          <div className="k">{status === 'trialing' ? 'Trial ends' : 'Renews'}</div>
          <div className={`v ${active ? '' : 'amber'}`} style={{ fontSize: 20 }}>
            {status === 'trialing'
              ? `${trialDaysLeft(company)} days`
              : company.current_period_end
                ? new Date(company.current_period_end).toLocaleDateString('en-IE')
                : '—'}
          </div>
        </div>
      </div>

      {!active && (
        <p className="dim">
          {status === 'trialing'
            ? 'Your trial has ended.'
            : 'Your subscription is not active.'}{' '}
          Subscribe to keep running live tracking and adding workers. Your data is safe — nothing is
          deleted.
        </p>
      )}

      <h3>Subscription</h3>
      <p className="dim small">
        {priceHint}. You’re billed for the number of active workers ({company.active_workers} right
        now). Deactivating a worker removes their seat at the next renewal.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        {status !== 'active' && (
          <button disabled={busy !== null} onClick={() => run('checkout', startCheckout)}>
            {busy === 'checkout' ? 'Opening…' : 'Subscribe'}
          </button>
        )}
        {company.has_customer && (
          <button className="ghost" disabled={busy !== null} onClick={() => run('portal', openPortal)}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <p className="dim small" style={{ marginTop: 24 }}>
        Payments are handled securely by Stripe. We never see or store your card details.
      </p>
    </div>
  );
}
