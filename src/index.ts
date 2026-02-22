import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import pool from './db/connection';
import { isSecretKey, encrypt } from './utils/crypto';

// Routes
import authRoutes from './routes/auth';
import articlesRoutes from './routes/articles';
import projectsRoutes from './routes/projects';
import eventsRoutes from './routes/events';
import categoriesRoutes from './routes/categories';
import commentsRoutes from './routes/comments';
import donationsRoutes from './routes/donations';
import membershipsRoutes from './routes/memberships';
import contactRoutes from './routes/contact';
import newsletterRoutes from './routes/newsletter';
import teamRoutes from './routes/team';
import partnersRoutes from './routes/partners';
import testimonialsRoutes from './routes/testimonials';
import siteContentRoutes from './routes/siteContent';
import siteSettingsRoutes from './routes/siteSettings';
import newsRoutes from './routes/news';
import uploadRoutes from './routes/upload';
import stripeRoutes from './routes/stripe';
import receiptsRoutes from './routes/receipts';
import automationRoutes from './routes/automation';
import cleanupRoutes from './routes/cleanup';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });


const app = express();
const PORT = process.env.PORT || 4000;

// Rate limiting — generous for SPA that fires many parallel requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());
app.use(limiter);

// Strict rate limit on authentication routes (login, register, 2FA)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Veuillez réessayer dans 15 minutes.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/verify-2fa', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));

// Static uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/articles', articlesRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/donations', donationsRoutes);
app.use('/api/memberships', membershipsRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/partners', partnersRoutes);
app.use('/api/testimonials', testimonialsRoutes);
app.use('/api/site-content', siteContentRoutes);
app.use('/api/site-settings', siteSettingsRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/cleanup', cleanupRoutes);

// Health check
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, async () => {
  console.log(`🚀 Express server running on http://localhost:${PORT}`);

  // Auto-migrate: add social auth columns if missing
  const migrations = [
    'ALTER TABLE users ADD COLUMN google_id VARCHAR(255) NULL',
    'ALTER TABLE users ADD COLUMN facebook_id VARCHAR(255) NULL',
    'ALTER TABLE users ADD COLUMN twitter_id VARCHAR(255) NULL',
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'google_client_id', '', 'text', 'Google Client ID', 'ID client Google pour la connexion OAuth', 'auth', 50)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'facebook_app_id', '', 'text', 'Facebook App ID', 'ID de l\\'application Facebook pour la connexion OAuth', 'auth', 51)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'site_url', 'https://ecolocal-beziers.fr', 'text', 'URL du site', 'URL publique du site pour les partages et OpenGraph', 'general', 5)",
    // Receipt template settings
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_name', 'Association Ecolocal', 'text', 'Nom de l\\'organisation', 'Nom affiché sur les reçus', 'receipt', 1)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_address', '', 'text', 'Adresse', 'Adresse de l\\'organisation', 'receipt', 2)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_phone', '', 'text', 'Téléphone', 'Numéro de téléphone', 'receipt', 3)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_email', '', 'text', 'Email', 'Email de contact', 'receipt', 4)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_siret', '', 'text', 'N° SIRET', 'Numéro SIRET de l\\'organisation', 'receipt', 5)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_org_rna', '', 'text', 'N° RNA', 'Numéro RNA de l\\'association', 'receipt', 6)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_primary_color', '#166534', 'text', 'Couleur principale', 'Couleur principale du reçu (hex)', 'receipt', 10)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_secondary_color', '#15803d', 'text', 'Couleur secondaire', 'Couleur secondaire du reçu (hex)', 'receipt', 11)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_donation_title', 'Reçu de don', 'text', 'Titre reçu don', 'Titre affiché sur les reçus de dons', 'receipt', 20)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_membership_title', 'Reçu d\\'adhésion', 'text', 'Titre reçu adhésion', 'Titre affiché sur les reçus d\\'adhésion', 'receipt', 21)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_footer_text', 'Ce reçu est délivré en vertu de l\\'article 200 du Code Général des Impôts.', 'textarea', 'Texte de pied de page', 'Texte légal en bas du reçu', 'receipt', 30)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'receipt_show_tax_info', 'true', 'boolean', 'Afficher info fiscale', 'Afficher le bloc de réduction d\\'impôt', 'receipt', 31)",
    // Contact messages: add emailed column
    'ALTER TABLE contact_messages ADD COLUMN emailed TINYINT(1) NOT NULL DEFAULT 0',
    // Replace Resend/SendGrid with Nodemailer SMTP settings
    "UPDATE site_settings SET setting_value = 'nodemailer' WHERE setting_key = 'email_provider' AND setting_value IN ('resend', 'sendgrid')",
    "DELETE FROM site_settings WHERE setting_key IN ('email_resend_api_key', 'email_sendgrid_api_key')",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_host', '', 'text', 'Serveur SMTP', 'Adresse du serveur SMTP (ex: smtp.gmail.com)', 'emails', 10)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_port', '587', 'text', 'Port SMTP', 'Port du serveur (587 pour TLS, 465 pour SSL)', 'emails', 11)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_secure', 'false', 'boolean', 'SSL/TLS', 'Utiliser SSL (true pour port 465)', 'emails', 12)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_user', '', 'text', 'Utilisateur SMTP', 'Nom d\'utilisateur SMTP (ex: resend)', 'emails', 13)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_from_address', '', 'text', 'Email expéditeur', 'Adresse email utilisée comme expéditeur (ex: test@devnotifs.com)', 'emails', 15)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_pass', '', 'secret', 'Mot de passe SMTP', 'Mot de passe ou mot de passe d\\'application', 'emails', 14)",
    // Update labels for email settings
    "UPDATE site_settings SET label = 'Fournisseur d\\'email', description = 'Nodemailer (SMTP) pour envoyer par email, ou Aucun pour consulter sur le site' WHERE setting_key = 'email_provider'",
    "UPDATE site_settings SET label = 'Nom expéditeur', description = 'Nom affiché comme expéditeur des emails' WHERE setting_key = 'email_from_name'",
    "UPDATE site_settings SET label = 'Destinataire contact', description = 'Email qui reçoit les messages du formulaire de contact' WHERE setting_key = 'email_contact_recipient'",
    // Newsletter sends history table
    `CREATE TABLE IF NOT EXISTS newsletter_sends (
      id VARCHAR(36) PRIMARY KEY,
      subject VARCHAR(500) NOT NULL,
      intro_text TEXT,
      content_json JSON,
      sent_count INT DEFAULT 0,
      failed_count INT DEFAULT 0,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // Merge newsletter into emails category — remove old Mailchimp/Brevo settings, add newsletter_enabled toggle
    "DELETE FROM site_settings WHERE category = 'newsletter'",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'newsletter_enabled', 'false', 'boolean', 'Newsletter activée', 'Activer l\\'envoi de newsletters via SMTP', 'emails', 20)",
    // Facebook Graph API automation settings
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'auto_post_enabled', 'false', 'boolean', 'Publication automatique', 'Publier automatiquement les articles sur les réseaux sociaux', 'automation', 1)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'auto_post_facebook', 'false', 'boolean', 'Publier sur Facebook', 'Poster les articles sur votre page Facebook', 'automation', 2)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'auto_post_instagram', 'false', 'boolean', 'Publier sur Instagram', 'Poster les articles sur votre compte Instagram Business', 'automation', 3)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'fb_page_access_token', '', 'secret', 'Token d\\'accès Page Facebook', 'Token longue durée de la page Facebook (voir aide ci-dessous)', 'automation', 10)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'fb_page_id', '', 'text', 'ID de la Page Facebook', 'Identifiant numérique de votre page Facebook', 'automation', 11)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'ig_business_account_id', '', 'text', 'ID du compte Instagram Business', 'Identifiant du compte Instagram lié à la page Facebook', 'automation', 12)",
    // Stripe checkout branding
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'checkout_background_image', '', 'text', 'Image de fond Checkout', 'URL d\\'une image de fond affichée dans la page de paiement Stripe', 'payments', 30)",
    // 2FA settings
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), '2fa_enabled', 'false', 'boolean', 'Authentification à deux facteurs', 'Activer la vérification par code email lors de la connexion', 'auth', 60)",
    // 2FA codes table
    `CREATE TABLE IF NOT EXISTS two_factor_codes (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    // Add 2fa_enabled column to users (default OFF — user must opt in)
    'ALTER TABLE users ADD COLUMN two_factor_enabled TINYINT(1) NOT NULL DEFAULT 0',
    // Event confirmation email settings
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'event_email_enabled', 'true', 'boolean', 'Email inscription événement', 'Envoyer un email de confirmation lors de l\\'inscription à un événement', 'events', 1)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'event_email_subject', 'Inscription confirmée — {{EVENT}}', 'text', 'Sujet de l\\'email', 'Sujet du mail. Utilisez {{EVENT}} pour le nom de l\\'événement', 'events', 2)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'event_email_intro', 'Votre inscription à l\\'événement suivant est confirmée :', 'textarea', 'Texte d\\'introduction', 'Texte affiché avant les détails. Variables: {{NAME}}, {{EVENT}}', 'events', 3)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'event_email_footer', 'Nous avons hâte de vous y retrouver !', 'textarea', 'Texte de pied', 'Texte affiché après les détails. Variables: {{NAME}}, {{EVENT}}', 'events', 4)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'event_email_color', '#166534', 'text', 'Couleur de l\\'email', 'Couleur principale utilisée dans l\\'email (hex)', 'events', 5)",
    // Social posts log table
    `CREATE TABLE IF NOT EXISTS social_posts_log (
      id VARCHAR(36) PRIMARY KEY,
      article_id VARCHAR(36) NOT NULL,
      platform ENUM('facebook','instagram') NOT NULL,
      post_id VARCHAR(255) DEFAULT NULL,
      status ENUM('success','error') NOT NULL,
      error_message TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    )`,
    // Event registrations table
    `CREATE TABLE IF NOT EXISTS event_registrations (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      status VARCHAR(50) DEFAULT 'confirmed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY unique_registration (event_id, user_id)
    )`,
    // Password reset codes table
    `CREATE TABLE IF NOT EXISTS password_resets (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      reset_token VARCHAR(36) DEFAULT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
  ];

  for (const sql of migrations) {
    try { await pool.query(sql); } catch (_) { /* column/row already exists */ }
  }

  // ─── Encrypt any plaintext secrets still in site_settings ───
  try {
    const [secretRows] = await pool.query('SELECT setting_key, setting_value FROM site_settings') as any[];
    for (const row of secretRows) {
      if (isSecretKey(row.setting_key) && row.setting_value && !row.setting_value.startsWith('enc:')) {
        const encrypted = encrypt(row.setting_value);
        await pool.query('UPDATE site_settings SET setting_value = ? WHERE setting_key = ?', [encrypted, row.setting_key]);
        console.log(`🔒 Encrypted existing secret: ${row.setting_key}`);
      }
    }
  } catch (err) {
    console.error('Secret encryption migration error:', err);
  }

  // ─── Mark stale pending donations/memberships (>1 day) as expired on startup ───
  try {
    const [donResult] = await pool.query(
      "UPDATE donations SET status = 'expired' WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)"
    ) as any;
    if (donResult.affectedRows > 0) {
      console.log(`🧹 Cleanup: ${donResult.affectedRows} stale pending donation(s) marked as expired`);
    }
    const [memResult] = await pool.query(
      "UPDATE memberships SET status = 'expired' WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)"
    ) as any;
    if (memResult.affectedRows > 0) {
      console.log(`🧹 Cleanup: ${memResult.affectedRows} stale pending membership(s) marked as expired`);
    }
  } catch (err) {
    console.error('Startup cleanup error:', err);
  }

  // ─── Periodic cleanup every 6 hours ───
  setInterval(async () => {
    try {
      await pool.query(
        "UPDATE donations SET status = 'expired' WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)"
      );
      await pool.query(
        "UPDATE memberships SET status = 'expired' WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)"
      );
      console.log('🧹 Periodic cleanup: stale pending records marked as expired');
    } catch (err) {
      console.error('Periodic cleanup error:', err);
    }
  }, 6 * 60 * 60 * 1000);
});

export default app;
