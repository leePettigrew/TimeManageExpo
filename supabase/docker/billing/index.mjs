// TimeTable billing service — Stripe subscriptions for the per-worker plan.
// Endpoints (called by the dashboard with the manager's Supabase JWT):
//   POST /create-checkout  → Stripe Checkout URL to start a subscription
//   POST /portal           → Stripe billing-portal URL to manage/cancel
//   POST /sync-seats       → set the subscription quantity to active workers
//   POST /webhook          → Stripe → billing_sync() (verified signature)
//   GET  /health
//
// Maps Stripe ⇄ company via company_id stored in Stripe metadata. Writes back
// through the billing_sync() RPC over a direct Postgres connection (service
// role bypasses RLS). No Stripe secret ever reaches the browser.
import express from 'express';
import Stripe from 'stripe';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const {
  DATABASE_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  JWT_SECRET,
  DASHBOARD_URL,
  PORT = '8787',
} = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, JWT_SECRET, DASHBOARD_URL })) {
  if (!v) {
    console.error(`billing: missing required env ${k}`);
    process.exit(1);
  }
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const app = express();

async function activeWorkers(companyId) {
  const { rows } = await pool.query(`select internal.active_worker_count($1) n`, [companyId]);
  return Math.max(1, rows[0]?.n ?? 1); // Stripe requires quantity >= 1
}

async function syncFromSubscription(sub) {
  const companyId = sub.metadata?.company_id;
  if (!companyId) return;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  const seats = sub.items?.data?.[0]?.quantity ?? null;
  await pool.query(`select billing_sync($1,$2,$3,$4,$5,$6)`, [
    companyId,
    typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
    sub.id,
    sub.status,
    periodEnd,
    seats,
  ]);
}

// ── webhook (raw body, mounted before the JSON parser) ───────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    return res.status(400).send(`bad signature: ${e.message}`);
  }
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncFromSubscription(event.data.object);
        break;
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.metadata?.company_id && s.customer) {
          await pool.query(`select billing_sync($1,$2,null,null,null,null)`, [s.metadata.company_id, s.customer]);
          if (s.subscription) {
            const sub = await stripe.subscriptions.retrieve(s.subscription);
            await syncFromSubscription(sub);
          }
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('webhook handler error:', e.message);
    res.status(500).send('handler error');
  }
});

app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', DASHBOARD_URL);
  res.set('Access-Control-Allow-Headers', 'authorization,content-type');
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

// verify the Supabase JWT and load the caller's manager profile + company
async function authManager(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = jwt.verify(token, JWT_SECRET); // throws on invalid/expired
  const uid = payload.sub;
  const { rows } = await pool.query(
    `select p.id, p.role, p.company_id, c.name, c.stripe_customer_id, c.stripe_subscription_id
     from profiles p join companies c on c.id = p.company_id
     where p.id = $1 and p.is_active`,
    [uid],
  );
  if (!rows.length) throw new Error('no profile');
  if (rows[0].role !== 'manager') throw new Error('managers only');
  return rows[0];
}

app.post('/create-checkout', async (req, res) => {
  try {
    const m = await authManager(req);
    let customerId = m.stripe_customer_id;
    if (!customerId) {
      const cust = await stripe.customers.create({
        name: m.name,
        metadata: { company_id: m.company_id },
      });
      customerId = cust.id;
      await pool.query(`select billing_sync($1,$2,null,null,null,null)`, [m.company_id, customerId]);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: await activeWorkers(m.company_id) }],
      metadata: { company_id: m.company_id },
      subscription_data: { metadata: { company_id: m.company_id } },
      allow_promotion_codes: true,
      success_url: `${DASHBOARD_URL}/?billing=success`,
      cancel_url: `${DASHBOARD_URL}/?billing=cancel`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/portal', async (req, res) => {
  try {
    const m = await authManager(req);
    if (!m.stripe_customer_id) return res.status(400).json({ error: 'no_customer' });
    const session = await stripe.billingPortal.sessions.create({
      customer: m.stripe_customer_id,
      return_url: DASHBOARD_URL,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// keep the billed quantity in step with the active-worker count
app.post('/sync-seats', async (req, res) => {
  try {
    const m = await authManager(req);
    if (!m.stripe_subscription_id) return res.json({ skipped: 'no_subscription' });
    const sub = await stripe.subscriptions.retrieve(m.stripe_subscription_id);
    const item = sub.items.data[0];
    const qty = await activeWorkers(m.company_id);
    if (item.quantity !== qty) {
      await stripe.subscriptionItems.update(item.id, { quantity: qty, proration_behavior: 'create_prorations' });
    }
    res.json({ seats: qty });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => console.log(`billing service listening on ${PORT}`));
