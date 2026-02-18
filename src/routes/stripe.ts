import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

const router = Router();

// ─── Stripe instance (lazy init, reads keys from DB) ───

let _stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('stripe_secret_key', 'stripe_enabled')"
  );
  const settings: Record<string, string> = {};
  for (const r of rows as any[]) settings[r.setting_key] = r.setting_value;

  if (settings.stripe_enabled !== 'true') {
    throw new Error('Stripe n\'est pas activé. Activez-le dans Paramètres → Paiements.');
  }
  if (!settings.stripe_secret_key) {
    throw new Error('Clé secrète Stripe non configurée. Ajoutez-la dans Paramètres → Paiements.');
  }

  _stripe = new Stripe(settings.stripe_secret_key, { apiVersion: '2025-04-30.basil' as any });
  return _stripe;
}

// Reset cache when settings change
export function resetStripeCache() { _stripe = null; }

async function getSetting(key: string): Promise<string> {
  const [rows] = await pool.query('SELECT setting_value FROM site_settings WHERE setting_key = ?', [key]);
  return (rows as any[])[0]?.setting_value || '';
}

async function getCheckoutBranding(): Promise<{
  logo: string | undefined;
  background: string | undefined;
  siteName: string;
}> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('site_logo_url', 'checkout_background_image', 'site_name', 'site_url')"
  );
  const settings: Record<string, string> = {};
  for (const r of rows as any[]) settings[r.setting_key] = r.setting_value;

  const siteUrl = settings.site_url || process.env.FRONTEND_URL || 'http://localhost:3000';

  // Stripe requires absolute URLs for images
  const makeAbsolute = (url?: string) => {
    if (!url) return undefined;
    if (url.startsWith('http')) return url;
    return `${siteUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  return {
    logo: makeAbsolute(settings.site_logo_url) || undefined,
    background: makeAbsolute(settings.checkout_background_image) || undefined,
    siteName: settings.site_name || 'Association',
  };
}

async function getOrCreateStripeCustomer(stripe: Stripe, userId: string, email: string, name?: string): Promise<string> {
  // Check if user already has a stripe customer id
  const [users] = await pool.query('SELECT stripe_customer_id FROM users WHERE id = ?', [userId]);
  const existingId = (users as any[])[0]?.stripe_customer_id;
  if (existingId) return existingId;

  // Create new customer
  const customer = await stripe.customers.create({
    email,
    name: name || undefined,
    metadata: { user_id: userId },
  });

  await pool.query('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customer.id, userId]);
  return customer.id;
}

// ─── Checkout: One-time donation ───

router.post('/checkout/donation', authenticate, async (req, res) => {
  try {
    const stripe = await getStripe();
    const { amount, donor_name, donor_email, donor_message } = req.body;
    const currency = await getSetting('stripe_currency') || 'eur';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Montant invalide (minimum 1€)' });
    }

    const donationId = uuid();
    const customerId = await getOrCreateStripeCustomer(
      stripe, req.user!.id, donor_email || req.user!.email, donor_name
    );

    const branding = await getCheckoutBranding();
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: 'Don ponctuel',
            description: `Don de ${amount}€ pour soutenir ${branding.siteName}`,
            ...(branding.logo ? { images: [branding.logo] } : {}),
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      metadata: {
        type: 'donation',
        donation_id: donationId,
        user_id: req.user!.id,
        is_recurring: 'false',
      },
      ...(branding.background ? { custom_text: { submit: { message: `Merci pour votre soutien à ${branding.siteName} !` } } } : {}),
      success_url: `${frontendUrl}/don?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/don?cancelled=true`,
    });

    // Save pending donation
    await pool.query(
      `INSERT INTO donations (id, amount, currency, status, user_id, donor_name, donor_email, donor_message, is_recurring, stripe_session_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, false, ?)`,
      [donationId, amount, currency.toUpperCase(), req.user!.id, donor_name || null, donor_email || null, donor_message || null, session.id]
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error: any) {
    console.error('Checkout donation error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// ─── Checkout: Monthly donation (subscription) ───

router.post('/checkout/donation-monthly', authenticate, async (req, res) => {
  try {
    const stripe = await getStripe();
    const { amount, donor_name, donor_email, donor_message } = req.body;
    const currency = await getSetting('stripe_currency') || 'eur';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Montant invalide (minimum 1€)' });
    }

    const donationId = uuid();
    const customerId = await getOrCreateStripeCustomer(
      stripe, req.user!.id, donor_email || req.user!.email, donor_name
    );

    const branding = await getCheckoutBranding();
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: 'Don mensuel',
            description: `Don mensuel de ${amount}€/mois pour ${branding.siteName}`,
            ...(branding.logo ? { images: [branding.logo] } : {}),
          },
          unit_amount: Math.round(amount * 100),
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      metadata: {
        type: 'donation_monthly',
        donation_id: donationId,
        user_id: req.user!.id,
        is_recurring: 'true',
      },
      ...(branding.background ? { custom_text: { submit: { message: `Merci pour votre soutien mensuel à ${branding.siteName} !` } } } : {}),
      success_url: `${frontendUrl}/don?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/don?cancelled=true`,
    });

    await pool.query(
      `INSERT INTO donations (id, amount, currency, status, user_id, donor_name, donor_email, donor_message, is_recurring, recurring_interval, stripe_session_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, true, 'month', ?)`,
      [donationId, amount, currency.toUpperCase(), req.user!.id, donor_name || null, donor_email || null, donor_message || null, session.id]
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error: any) {
    console.error('Checkout donation monthly error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// ─── Checkout: Membership ───

router.post('/checkout/membership', authenticate, async (req, res) => {
  try {
    const stripe = await getStripe();
    const { first_name, last_name, email, phone, address, share_profile, membership_type } = req.body;
    const currency = await getSetting('stripe_currency') || 'eur';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const membershipPrice = Number(await getSetting('membership_price')) || 20;

    const membershipId = uuid();
    const fullName = `${first_name} ${last_name}`.trim();
    const customerId = await getOrCreateStripeCustomer(
      stripe, req.user!.id, email || req.user!.email, fullName
    );

    const branding = await getCheckoutBranding();
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: `Adhésion annuelle — ${branding.siteName}`,
            description: `Adhésion membre pour 1 an — ${membershipPrice}€`,
            ...(branding.logo ? { images: [branding.logo] } : {}),
          },
          unit_amount: Math.round(membershipPrice * 100),
        },
        quantity: 1,
      }],
      metadata: {
        type: 'membership',
        membership_id: membershipId,
        user_id: req.user!.id,
      },
      ...(branding.background ? { custom_text: { submit: { message: `Bienvenue chez ${branding.siteName} ! Merci pour votre adhésion.` } } } : {}),
      success_url: `${frontendUrl}/don?mode=membre&success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/don?mode=membre&cancelled=true`,
    });

    // Save pending membership
    const startDate = new Date();
    const endDate = new Date();
    endDate.setFullYear(endDate.getFullYear() + 1);

    await pool.query(
      `INSERT INTO memberships (id, user_id, email, first_name, last_name, phone, address, membership_type, amount, status, start_date, end_date, share_profile, stripe_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [membershipId, req.user!.id, email, first_name, last_name, phone || null, address || null, membership_type || 'standard', membershipPrice, startDate, endDate, share_profile ?? false, session.id]
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error: any) {
    console.error('Checkout membership error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// ─── Session status check & confirm ───
// This endpoint both returns session info AND activates the payment if paid.
// Acts as a fallback for when the webhook hasn't fired yet (e.g. localhost dev).

router.post('/session/:sessionId/confirm', authenticate, async (req, res) => {
  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const metadata = session.metadata || {};
    const userId = req.user!.id;

    // Only process if the session belongs to this user
    if (metadata.user_id && metadata.user_id !== userId) {
      return res.status(403).json({ error: 'Session non associée à cet utilisateur' });
    }

    if (session.payment_status === 'paid') {
      // Activate donation
      if (metadata.type === 'donation' || metadata.type === 'donation_monthly') {
        await pool.query(
          "UPDATE donations SET status = 'completed', stripe_payment_intent_id = ? WHERE stripe_session_id = ? AND status = 'pending'",
          [session.payment_intent || session.subscription || null, session.id]
        );
      }

      // Activate membership
      if (metadata.type === 'membership') {
        const [updated] = await pool.query(
          "UPDATE memberships SET status = 'active' WHERE stripe_session_id = ? AND status = 'pending'",
          [session.id]
        ) as any;

        // Add 'member' role if membership was activated
        if (updated.affectedRows > 0) {
          const [existingRole] = await pool.query(
            "SELECT id FROM user_roles WHERE user_id = ? AND role = 'member'",
            [userId]
          );
          if ((existingRole as any[]).length === 0) {
            await pool.query(
              "INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, 'member')",
              [uuid(), userId]
            );
          }
        }
      }
    }

    res.json({
      status: session.payment_status,
      type: metadata.type,
      customer_email: session.customer_details?.email,
      amount_total: session.amount_total ? session.amount_total / 100 : null,
      metadata,
      activated: session.payment_status === 'paid',
    });
  } catch (error: any) {
    console.error('Confirm session error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

router.get('/session/:sessionId', authenticate, async (req, res) => {
  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.payment_status,
      customer_email: session.customer_details?.email,
      amount_total: session.amount_total ? session.amount_total / 100 : null,
      metadata: session.metadata,
    });
  } catch (error: any) {
    console.error('Get session error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// ─── Stripe Webhook (raw body is ensured by index.ts) ───

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;
  try {
    const stripe = await getStripe();
    const webhookSecret = await getSetting('stripe_webhook_secret');

    if (!webhookSecret) {
      console.error('Stripe webhook secret not configured');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const metadata = session.metadata || {};

        if (metadata.type === 'donation' || metadata.type === 'donation_monthly') {
          // Update donation status
          await pool.query(
            "UPDATE donations SET status = 'completed', stripe_payment_intent_id = ? WHERE stripe_session_id = ?",
            [session.payment_intent || session.subscription || null, session.id]
          );
          console.log(`✅ Donation ${metadata.donation_id} completed`);
        }

        if (metadata.type === 'membership') {
          // Activate membership
          await pool.query(
            "UPDATE memberships SET status = 'active', stripe_session_id = ? WHERE stripe_session_id = ?",
            [session.id, session.id]
          );

          // Also add 'member' role to user_roles if not exists
          const userId = metadata.user_id;
          if (userId) {
            const [existingRole] = await pool.query(
              "SELECT id FROM user_roles WHERE user_id = ? AND role = 'member'",
              [userId]
            );
            if ((existingRole as any[]).length === 0) {
              await pool.query(
                "INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, 'member')",
                [uuid(), userId]
              );
            }
          }
          console.log(`✅ Membership ${metadata.membership_id} activated`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // For recurring donations — renew
        const invoice = event.data.object as any;
        const subscriptionId = invoice.subscription as string;
        if (subscriptionId) {
          // Find donation by subscription and create new payment record
          const [donations] = await pool.query(
            "SELECT * FROM donations WHERE stripe_payment_intent_id = ? AND is_recurring = true LIMIT 1",
            [subscriptionId]
          );
          const original = (donations as any[])[0];
          if (original && invoice.billing_reason === 'subscription_cycle') {
            await pool.query(
              `INSERT INTO donations (id, amount, currency, status, user_id, donor_name, donor_email, is_recurring, recurring_interval, stripe_session_id, stripe_payment_intent_id)
               VALUES (?, ?, ?, 'completed', ?, ?, ?, true, 'month', ?, ?)`,
              [uuid(), original.amount, original.currency, original.user_id, original.donor_name, original.donor_email, null, subscriptionId]
            );
            console.log(`✅ Recurring donation renewed for user ${original.user_id}`);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Monthly donation cancelled
        const subscription = event.data.object as Stripe.Subscription;
        await pool.query(
          "UPDATE donations SET status = 'cancelled' WHERE stripe_payment_intent_id = ? AND is_recurring = true",
          [subscription.id]
        );
        console.log(`🛑 Subscription ${subscription.id} cancelled`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await pool.query(
          "UPDATE donations SET status = 'failed' WHERE stripe_payment_intent_id = ? OR stripe_session_id IN (SELECT id FROM (SELECT stripe_session_id as id FROM donations WHERE stripe_payment_intent_id = ?) t)",
          [paymentIntent.id, paymentIntent.id]
        );
        console.log(`❌ Payment failed: ${paymentIntent.id}`);
        break;
      }

      case 'checkout.session.expired': {
        const expiredSession = event.data.object as Stripe.Checkout.Session;
        // Mark pending donations as expired (non abouti) when user abandons checkout
        const [donResult] = await pool.query(
          "UPDATE donations SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'",
          [expiredSession.id]
        ) as any;
        if (donResult.affectedRows > 0) {
          console.log(`🛑 Donation expired (checkout abandoned): session ${expiredSession.id}`);
        }
        // Mark pending memberships as expired too
        const [memResult] = await pool.query(
          "UPDATE memberships SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'",
          [expiredSession.id]
        ) as any;
        if (memResult.affectedRows > 0) {
          console.log(`🛑 Membership expired (checkout abandoned): session ${expiredSession.id}`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

export default router;
