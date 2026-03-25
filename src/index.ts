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
import projectSectionsRoutes from './routes/projectSections';
import projectFilesRoutes from './routes/project-files';
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
import vignettesRoutes from './routes/vignettes';
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
app.use('/api/project-sections', projectSectionsRoutes);
app.use('/api/project-files', projectFilesRoutes);
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
app.use('/api/vignettes', vignettesRoutes);
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
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_from_name', '', 'text', 'Nom expéditeur', 'Nom affiché comme expéditeur des emails', 'emails', 16)",
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'email_smtp_pass', '', 'secret', 'Mot de passe SMTP', 'Mot de passe ou mot de passe d\\'application', 'emails', 14)",
    // Update labels for email settings
    "UPDATE site_settings SET label = 'Fournisseur d\\'email', description = 'Nodemailer (SMTP) pour envoyer par email, ou Aucun pour consulter sur le site' WHERE setting_key = 'email_provider'",
    "UPDATE site_settings SET label = 'Nom expéditeur', description = 'Nom affiché comme expéditeur des emails' WHERE setting_key = 'email_from_name'",
    "UPDATE site_settings SET label = 'Destinataire contact', description = 'Email qui reçoit les messages du formulaire de contact' WHERE setting_key = 'email_contact_recipient'",
    // Vignettes table (thumbnails for home page hero section)
    `CREATE TABLE IF NOT EXISTS vignettes (
      id VARCHAR(36) PRIMARY KEY,
      image_url TEXT DEFAULT NULL,
      display_order INT NOT NULL DEFAULT 0,
      published TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
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
    // Favicon setting
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'site_favicon_url', '', 'image', 'Favicon du site', 'Icône affichée dans l\\'onglet du navigateur (.ico, .png, .svg)', 'branding', 5)",
    // Auth background image setting
    "INSERT IGNORE INTO site_settings (id, setting_key, setting_value, setting_type, label, description, category, display_order) VALUES (UUID(), 'auth_background_image', '', 'image', 'Image de fond (connexion / inscription)', 'Image affichée sur les pages de connexion, inscription et vérification', 'branding', 10)",
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
    // Add attempts column to two_factor_codes and password_resets for brute-force protection
    'ALTER TABLE two_factor_codes ADD COLUMN attempts INT NOT NULL DEFAULT 0',
    'ALTER TABLE password_resets ADD COLUMN attempts INT NOT NULL DEFAULT 0',
    // Homepage flag for articles
    'ALTER TABLE articles ADD COLUMN show_on_home TINYINT(1) NOT NULL DEFAULT 0',
    // Evolution timeline image on About page (with zoom toggle)
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label) VALUES (UUID(), 'about', 'evolution_title', 'Évolution de l\\'association', 'text', 'Titre image évolution')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label) VALUES (UUID(), 'about', 'evolution_image', '', 'image', 'Image frise évolution')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label) VALUES (UUID(), 'about', 'evolution_zoom_enabled', 'true', 'toggle', 'Activer le zoom au survol')",
    // ═══ Phase 1: Amélioration back-office site_content ═══
    'ALTER TABLE site_content ADD COLUMN display_order INT NOT NULL DEFAULT 0',
    'ALTER TABLE site_content ADD COLUMN section VARCHAR(100) DEFAULT NULL',
    'ALTER TABLE site_content ADD COLUMN description TEXT DEFAULT NULL',
    // Remove legacy interactive bubbles feature
    'DROP TABLE IF EXISTS interactive_bubbles',
    "DELETE FROM site_content WHERE content_key IN ('bubbles_title', 'bubbles_description')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'home', 'hero_scroll_image', '', 'image', 'Image de transition (scroll)', 'hero', 5, 'Image affichée juste sous la bannière avec un effet de descente au scroll')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'home', 'hero_scroll_title', 'Titre à afficher', 'text', 'Titre animation transition (H2)', 'hero', 6, 'Texte H2 affiché sur l''image de transition et synchronisé avec son animation')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'home', 'hero_scroll_title_align', 'center', 'text', 'Alignement titre animation (H2)', 'hero', 7, 'Position du titre H2 sur l''image de transition: centre-gauche, centre, centre-droite')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'home', 'news_trailer_video_url', '', 'text', 'Vidéo bande-annonce (URL)', 'news', 2, 'URL YouTube/Vimeo ou fichier MP4 affichée en grand dans la section actualités de la page d''accueil')",
    // ═══ Phase 8: Configuration labels et ordre des champs ═══
    // Home - Hero section
    "UPDATE site_content SET section='hero', display_order=1, label='Badge au-dessus du titre', description='Petit texte affiché au-dessus du titre principal (ex: Association écologique)' WHERE page_key='home' AND content_key='hero_badge'",
    "UPDATE site_content SET section='hero', display_order=2, label='Titre principal', description='Le grand titre de la bannière d\\'accueil' WHERE page_key='home' AND content_key='hero_title'",
    "UPDATE site_content SET section='hero', display_order=3, label='Sous-titre / Description', description='Texte descriptif sous le titre principal' WHERE page_key='home' AND content_key='hero_subtitle'",
    "UPDATE site_content SET section='hero', display_order=4, label='Image de fond', description='Image d\\'arrière-plan de la bannière d\\'accueil' WHERE page_key='home' AND content_key='hero_image'",
    "UPDATE site_content SET section='hero', display_order=5, label='Image de transition (scroll)', description='Image affichée juste sous la bannière avec un effet de descente au scroll' WHERE page_key='home' AND content_key='hero_scroll_image'",
    "UPDATE site_content SET section='hero', display_order=6, label='Titre animation transition (H2)', description='Texte H2 affiché sur l''image de transition et synchronisé avec son animation' WHERE page_key='home' AND content_key='hero_scroll_title'",
    "UPDATE site_content SET section='hero', display_order=7, label='Alignement titre animation (H2)', description='Position du titre H2 sur l''image de transition: centre-gauche, centre, centre-droite' WHERE page_key='home' AND content_key='hero_scroll_title_align'",
    // Home - Mission section
    "UPDATE site_content SET section='mission', display_order=1, label='Titre mission', description='Titre de la section présentation de la mission' WHERE page_key='home' AND content_key='mission_title'",
    "UPDATE site_content SET section='mission', display_order=2, label='Description mission', description='Texte décrivant la mission de l\\'association' WHERE page_key='home' AND content_key='mission_description'",
    // Home - Features section
    "UPDATE site_content SET section='fonctionnalites', display_order=1, label='Fonctionnalité 1 - Titre', description='Titre de la première fonctionnalité' WHERE page_key='home' AND content_key='feature_1_title'",
    "UPDATE site_content SET section='fonctionnalites', display_order=2, label='Fonctionnalité 1 - Description', description='Description de la première fonctionnalité' WHERE page_key='home' AND content_key='feature_1_description'",
    "UPDATE site_content SET section='fonctionnalites', display_order=3, label='Fonctionnalité 2 - Titre', description='Titre de la deuxième fonctionnalité' WHERE page_key='home' AND content_key='feature_2_title'",
    "UPDATE site_content SET section='fonctionnalites', display_order=4, label='Fonctionnalité 2 - Description', description='Description de la deuxième fonctionnalité' WHERE page_key='home' AND content_key='feature_2_description'",
    "UPDATE site_content SET section='fonctionnalites', display_order=5, label='Fonctionnalité 3 - Titre', description='Titre de la troisième fonctionnalité' WHERE page_key='home' AND content_key='feature_3_title'",
    "UPDATE site_content SET section='fonctionnalites', display_order=6, label='Fonctionnalité 3 - Description', description='Description de la troisième fonctionnalité' WHERE page_key='home' AND content_key='feature_3_description'",
    // Home - Newsletter section
    "UPDATE site_content SET section='newsletter', display_order=1, label='Titre newsletter', description='Titre de la section inscription newsletter' WHERE page_key='home' AND content_key='newsletter_title'",
    "UPDATE site_content SET section='newsletter', display_order=2, label='Description newsletter', description='Texte invitant à s\\'inscrire à la newsletter' WHERE page_key='home' AND content_key='newsletter_description'",
    "UPDATE site_content SET section='newsletter', display_order=3, label='Image de fond newsletter', description='Image d\\'arrière-plan de la section newsletter' WHERE page_key='home' AND content_key='newsletter_bg_image'",
    // Home - News section
    "UPDATE site_content SET section='news', display_order=1, label='Titre actualités', description='Titre de la section actualités de la page d\'accueil' WHERE page_key='home' AND content_key='news_title'",
    "UPDATE site_content SET section='news', display_order=2, label='Vidéo bande-annonce (URL)', description='URL YouTube/Vimeo ou fichier MP4 affichée en grand sous le titre de la section actualités' WHERE page_key='home' AND content_key='news_trailer_video_url'",
    "UPDATE site_content SET section='news', display_order=3, label='Description actualités', description='Texte descriptif sous la vidéo de la section actualités' WHERE page_key='home' AND content_key='news_description'",
    // About page - Hero section
    "UPDATE site_content SET section='hero', display_order=1, label='Titre de la page', description='Titre principal de la page À propos' WHERE page_key='about' AND content_key='hero_title'",
    "UPDATE site_content SET section='hero', display_order=2, label='Sous-titre', description='Description sous le titre de la page' WHERE page_key='about' AND content_key='hero_subtitle'",
    // About page - Stats section
    "UPDATE site_content SET section='statistiques', display_order=1, label='Statistique 1 - Libellé', description='Nom de la première statistique (ex: Adhérents)' WHERE page_key='about' AND content_key='stat_1_label'",
    "UPDATE site_content SET section='statistiques', display_order=2, label='Statistique 1 - Valeur', description='Valeur de la première statistique (ex: 150+)' WHERE page_key='about' AND content_key='stat_1_value'",
    "UPDATE site_content SET section='statistiques', display_order=3, label='Statistique 2 - Libellé', description='Nom de la deuxième statistique' WHERE page_key='about' AND content_key='stat_2_label'",
    "UPDATE site_content SET section='statistiques', display_order=4, label='Statistique 2 - Valeur', description='Valeur de la deuxième statistique' WHERE page_key='about' AND content_key='stat_2_value'",
    "UPDATE site_content SET section='statistiques', display_order=5, label='Statistique 3 - Libellé', description='Nom de la troisième statistique' WHERE page_key='about' AND content_key='stat_3_label'",
    "UPDATE site_content SET section='statistiques', display_order=6, label='Statistique 3 - Valeur', description='Valeur de la troisième statistique' WHERE page_key='about' AND content_key='stat_3_value'",
    "UPDATE site_content SET section='statistiques', display_order=7, label='Statistique 4 - Libellé', description='Nom de la quatrième statistique' WHERE page_key='about' AND content_key='stat_4_label'",
    "UPDATE site_content SET section='statistiques', display_order=8, label='Statistique 4 - Valeur', description='Valeur de la quatrième statistique' WHERE page_key='about' AND content_key='stat_4_value'",
    // About page - Story section
    "UPDATE site_content SET section='histoire', display_order=1, label='Titre histoire', description='Titre de la section Notre histoire' WHERE page_key='about' AND content_key='story_title'",
    "UPDATE site_content SET section='histoire', display_order=2, label='Contenu histoire', description='Texte racontant l\\'histoire de l\\'association' WHERE page_key='about' AND content_key='story_content'",
    "UPDATE site_content SET section='histoire', display_order=3, label='Image de fond histoire', description='Image d\\'arrière-plan de la section histoire' WHERE page_key='about' AND content_key='story_bg_image'",
    // About page - Evolution/Timeline section
    "UPDATE site_content SET section='evolution', display_order=1, label='Titre frise chronologique', description='Titre au-dessus de l\\'image d\\'évolution' WHERE page_key='about' AND content_key='evolution_title'",
    "UPDATE site_content SET section='evolution', display_order=2, label='Image frise chronologique', description='Image représentant l\\'évolution de l\\'association' WHERE page_key='about' AND content_key='evolution_image'",
    "UPDATE site_content SET section='evolution', display_order=3, label='Activer zoom au survol', description='Permet de zoomer sur l\\'image au passage de la souris' WHERE page_key='about' AND content_key='evolution_zoom_enabled'",
    // About page - Values section
    "UPDATE site_content SET section='valeurs', display_order=1, label='Titre section valeurs', description='Titre de la section Nos valeurs' WHERE page_key='about' AND content_key='values_title'",
    "UPDATE site_content SET section='valeurs', display_order=2, label='Valeur 1 - Titre', description='Nom de la première valeur' WHERE page_key='about' AND content_key='value_1_title'",
    "UPDATE site_content SET section='valeurs', display_order=3, label='Valeur 1 - Description', description='Description de la première valeur' WHERE page_key='about' AND content_key='value_1_description'",
    "UPDATE site_content SET section='valeurs', display_order=4, label='Valeur 2 - Titre', description='Nom de la deuxième valeur' WHERE page_key='about' AND content_key='value_2_title'",
    "UPDATE site_content SET section='valeurs', display_order=5, label='Valeur 2 - Description', description='Description de la deuxième valeur' WHERE page_key='about' AND content_key='value_2_description'",
    "UPDATE site_content SET section='valeurs', display_order=6, label='Valeur 3 - Titre', description='Nom de la troisième valeur' WHERE page_key='about' AND content_key='value_3_title'",
    "UPDATE site_content SET section='valeurs', display_order=7, label='Valeur 3 - Description', description='Description de la troisième valeur' WHERE page_key='about' AND content_key='value_3_description'",
    "UPDATE site_content SET section='valeurs', display_order=8, label='Valeur 4 - Titre', description='Nom de la quatrième valeur' WHERE page_key='about' AND content_key='value_4_title'",
    "UPDATE site_content SET section='valeurs', display_order=9, label='Valeur 4 - Description', description='Description de la quatrième valeur' WHERE page_key='about' AND content_key='value_4_description'",
    // About page - Team section
    "UPDATE site_content SET section='equipe', display_order=1, label='Titre section équipe', description='Titre de la section Notre équipe' WHERE page_key='about' AND content_key='team_title'",
    "UPDATE site_content SET section='equipe', display_order=2, label='Description équipe', description='Texte de présentation de l\\'équipe' WHERE page_key='about' AND content_key='team_description'",
    // Discover page (new)
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'hero_title', 'Découvrez ECOLOCAL', 'text', 'Titre principal', 'hero', 1, 'Titre de la bannière de la page Découvrez-nous')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'hero_subtitle', 'Une association citoyenne engagée pour la transition écologique dans l\\'Hérault', 'textarea', 'Sous-titre', 'hero', 2, 'Description sous le titre de la page')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'hero_image', '', 'image', 'Image de fond', 'hero', 3, 'Image d\\'arrière-plan de la bannière')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'hero_title_color', '#319A78', 'text', 'Couleur titre bannière', 'hero', 4, 'Couleur du titre principal de la bannière (hex, ex: #319A78)')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'hero_subtitle_color', '#319A78', 'text', 'Couleur sous-titre bannière', 'hero', 5, 'Couleur du sous-titre de la bannière (hex ou rgba)')",
    "UPDATE site_content SET content_value='#319A78' WHERE page_key='discover' AND content_key='hero_title_color' AND content_value IN ('#ffffff', '#fff')",
    "UPDATE site_content SET content_value='#319A78' WHERE page_key='discover' AND content_key='hero_subtitle_color' AND content_value IN ('#ffffff', '#fff', 'rgba(255,255,255,0.9)')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'intro_title', 'Qui sommes-nous ?', 'text', 'Titre introduction', 'introduction', 1, 'Titre de la section d\\'introduction')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'intro_content', 'ECOLOCAL est une association citoyenne dédiée à la transition écologique locale.', 'textarea', 'Contenu introduction', 'introduction', 2, 'Texte de présentation de l\\'association')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'timeline_title', 'Évolution de l\\'association', 'text', 'Titre frise chronologique', 'evolution', 1, 'Titre de la section frise chronologique sur Découvrez-nous')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'timeline_image', '', 'image', 'Image frise chronologique', 'evolution', 2, 'Image de la frise affichée sur Découvrez-nous')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'timeline_zoom_enabled', 'true', 'toggle', 'Activer zoom frise', 'evolution', 3, 'Active un léger zoom de la frise au survol')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_title', 'Rejoignez le mouvement', 'text', 'Titre appel à action', 'cta', 1, 'Titre du bloc final d\\'appel à l\\'action')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_description', 'Ensemble, construisons un avenir plus durable pour notre territoire. Devenez membre ou soutenez nos actions.', 'textarea', 'Description appel à action', 'cta', 2, 'Texte principal du bloc final')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_primary_label', 'Devenir adhérent', 'text', 'Bouton principal - libellé', 'cta', 3, 'Texte du bouton principal')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_primary_url', '/don?mode=membre', 'text', 'Bouton principal - URL', 'cta', 4, 'Lien du bouton principal')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_secondary_label', 'Faire un don', 'text', 'Bouton secondaire - libellé', 'cta', 5, 'Texte du bouton secondaire')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'discover', 'cta_secondary_url', '/don', 'text', 'Bouton secondaire - URL', 'cta', 6, 'Lien du bouton secondaire')",
    // Projects page
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'hero_title', 'Nos projets', 'text', 'Titre bannière', 'hero', 1, 'Titre principal de la page Projets')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'hero_subtitle', 'Découvrez les initiatives portées par Ecolocal pour construire un territoire plus durable et solidaire.', 'textarea', 'Description bannière', 'hero', 2, 'Texte sous le titre principal de la bannière')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'hero_image', 'https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?w=1920', 'image', 'Image de fond bannière', 'hero', 3, 'Image d\\'arrière-plan de la bannière Projets')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'tabs_current_label', 'En cours', 'text', 'Onglet projets en cours', 'liste', 1, 'Texte affiché sur l\\'onglet des projets en cours')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'tabs_past_label', 'Passés', 'text', 'Onglet projets passés', 'liste', 2, 'Texte affiché sur l\\'onglet des projets terminés')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'cta_title', 'Vous avez une idée de projet ?', 'text', 'Titre appel à action', 'cta', 1, 'Titre du bloc final')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'projects', 'cta_description', 'Nous sommes toujours à la recherche de nouvelles initiatives. Partagez votre idée avec nous !', 'textarea', 'Description appel à action', 'cta', 2, 'Description du bloc final')",
    // Events page
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'hero_title', 'Nos Événements', 'text', 'Titre bannière', 'hero', 1, 'Titre principal de la page Événements')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'hero_subtitle', 'Rejoignez-nous lors de nos événements et actions sur le terrain. Ensemble, agissons pour un avenir durable.', 'textarea', 'Description bannière', 'hero', 2, 'Texte sous le titre principal')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'hero_image', '', 'image', 'Image de fond bannière', 'hero', 3, 'Image d\\'arrière-plan de la bannière Événements')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'filter_upcoming_label', 'À venir', 'text', 'Filtre événements à venir', 'liste', 1, 'Texte du bouton de filtre des événements futurs')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'filter_past_label', 'Passés', 'text', 'Filtre événements passés', 'liste', 2, 'Texte du bouton de filtre des événements passés')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'empty_upcoming_title', 'Aucun événement à venir', 'text', 'Message vide - titre (à venir)', 'messages', 1, 'Titre affiché quand aucun événement à venir n\\'est disponible')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'empty_upcoming_description', 'Revenez bientôt pour découvrir nos prochains événements !', 'textarea', 'Message vide - description (à venir)', 'messages', 2, 'Description affichée quand aucun événement futur n\\'est disponible')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'empty_past_title', 'Aucun événement passé', 'text', 'Message vide - titre (passés)', 'messages', 3, 'Titre affiché quand aucun événement passé n\\'est disponible')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'events', 'empty_past_description', 'Consultez nos événements à venir.', 'textarea', 'Message vide - description (passés)', 'messages', 4, 'Description affichée quand aucun événement passé n\\'est disponible')",
    // News page
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'hero_badge', 'Nos dernières nouvelles', 'text', 'Badge bannière', 'hero', 1, 'Texte du badge affiché au-dessus du titre')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'hero_title', 'Actualités', 'text', 'Titre bannière', 'hero', 2, 'Titre principal de la page Actualités')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'hero_subtitle', 'Suivez les dernières nouvelles d\\'Ecolocal : événements, projets, partenariats et initiatives écologiques.', 'textarea', 'Description bannière', 'hero', 3, 'Texte sous le titre principal')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'hero_image', 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=1920', 'image', 'Image de fond bannière', 'hero', 4, 'Image d\\'arrière-plan de la bannière Actualités')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'sort_date_label', 'Date', 'text', 'Tri par date', 'filtres', 1, 'Libellé du bouton de tri par date')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'sort_views_label', 'Vues', 'text', 'Tri par vues', 'filtres', 2, 'Libellé du bouton de tri par nombre de vues')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'sort_comments_label', 'Commentaires', 'text', 'Tri par commentaires', 'filtres', 3, 'Libellé du bouton de tri par commentaires')",
    "INSERT IGNORE INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description) VALUES (UUID(), 'news', 'empty_title', 'Aucune actualité pour le moment.', 'text', 'Message vide - titre', 'messages', 1, 'Titre affiché si aucune actualité n\\'est disponible')",
    // Labels plus explicites
    "UPDATE site_content SET label='Description bannière', description='Texte descriptif sous le titre principal de la bannière' WHERE page_key='home' AND content_key='hero_subtitle'",
    "UPDATE site_content SET label='Description bannière', description='Texte descriptif sous le titre principal de la bannière' WHERE page_key='about' AND content_key='hero_subtitle'",
    "UPDATE site_content SET label='Description bannière', description='Texte descriptif sous le titre principal de la bannière' WHERE page_key='discover' AND content_key='hero_subtitle'",
    // Project sections table (for discover page: customizable project zones with image, title, description, link, and layout)
    `CREATE TABLE IF NOT EXISTS project_sections (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      main_image_url TEXT DEFAULT NULL,
      thumbnail_image_url TEXT DEFAULT NULL,
      link_url VARCHAR(500) DEFAULT NULL,
      layout VARCHAR(50) NOT NULL DEFAULT 'text-right',
      display_order INT NOT NULL DEFAULT 0,
      published TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    'ALTER TABLE project_sections ADD COLUMN title_color VARCHAR(7) DEFAULT "#000000"',
    'ALTER TABLE project_sections ADD COLUMN description_color VARCHAR(7) DEFAULT "#666666"',
    'ALTER TABLE project_sections ADD COLUMN title_html TEXT',
    'ALTER TABLE project_sections ADD COLUMN main_image_urls TEXT',
    'ALTER TABLE project_sections ADD COLUMN thumbnail_position VARCHAR(10) DEFAULT "right"',
    `CREATE TABLE IF NOT EXISTS project_files (
      id VARCHAR(36) PRIMARY KEY,
      project_section_id VARCHAR(36) NOT NULL,
      file_url TEXT NOT NULL,
      file_name VARCHAR(500) NOT NULL,
      file_size INT DEFAULT NULL,
      file_type VARCHAR(120) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_section_id) REFERENCES project_sections(id) ON DELETE CASCADE
    )`,
  ];

  for (const sql of migrations) {
    try { 
      await pool.query(sql);
      if (sql.includes('vignettes')) {
        console.log('✅ Vignettes migration executed');
      }
      if (sql.includes('project_sections')) {
        console.log('✅ Project sections migration executed');
      }
      if (sql.includes('project_files')) {
        console.log('✅ Project files migration executed');
      }
    } catch (err) {
      console.error('❌ Migration error:', err instanceof Error ? err.message : err);
    }
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
