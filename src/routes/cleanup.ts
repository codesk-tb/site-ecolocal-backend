import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// Helper: run a stats query, return defaults on error
async function safeQuery(sql: string, defaults: Record<string, any>): Promise<Record<string, any>> {
  try {
    const [rows] = await pool.query(sql);
    return (rows as any[])[0] || defaults;
  } catch {
    return defaults;
  }
}

// ─── Get cleanup stats (counts & oldest dates per table) ───
router.get('/stats', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [articles, events, messages, donations, memberships, comments, newsletters, socialLogs, passwordResets] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*) as total, 
                SUM(CASE WHEN created_at < DATE_SUB(NOW(), INTERVAL 1 YEAR) THEN 1 ELSE 0 END) as old_count,
                MIN(created_at) as oldest
         FROM articles`,
        { total: 0, old_count: 0, oldest: null }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN event_date < CURDATE() THEN 1 ELSE 0 END) as past_count,
                MIN(event_date) as oldest
         FROM events`,
        { total: 0, past_count: 0, oldest: null }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN created_at < DATE_SUB(NOW(), INTERVAL 6 MONTH) THEN 1 ELSE 0 END) as old_count,
                MIN(created_at) as oldest
         FROM contact_messages`,
        { total: 0, old_count: 0, oldest: null }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
         FROM donations`,
        { total: 0, pending_count: 0, expired_count: 0, failed_count: 0 }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_count
         FROM memberships`,
        { total: 0, pending_count: 0, expired_count: 0 }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected_count
         FROM comments`,
        { total: 0, rejected_count: 0 }
      ),
      safeQuery(
        `SELECT COUNT(*) as total, MIN(sent_at) as oldest FROM newsletter_sends`,
        { total: 0, oldest: null }
      ),
      safeQuery(
        `SELECT COUNT(*) as total, MIN(created_at) as oldest FROM social_posts_log`,
        { total: 0, oldest: null }
      ),
      safeQuery(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN expires_at < NOW() THEN 1 ELSE 0 END) as expired_count
         FROM password_resets`,
        { total: 0, expired_count: 0 }
      ),
    ]);

    res.json({ articles, events, messages, donations, memberships, comments, newsletters, socialLogs, passwordResets });
  } catch (error) {
    console.error('Cleanup stats error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge old articles (>N months) ───
router.post('/articles', authenticate, requireAdmin, async (req, res) => {
  try {
    const { months = 12 } = req.body;
    const [result] = await pool.query(
      'DELETE FROM articles WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)',
      [months]
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} articles older than ${months} months`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge articles error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge past events ───
router.post('/events', authenticate, requireAdmin, async (req, res) => {
  try {
    const { months = 6 } = req.body;
    const [result] = await pool.query(
      'DELETE FROM events WHERE event_date < DATE_SUB(CURDATE(), INTERVAL ? MONTH)',
      [months]
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} past events older than ${months} months`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge events error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge old contact messages ───
router.post('/messages', authenticate, requireAdmin, async (req, res) => {
  try {
    const { months = 6 } = req.body;
    const [result] = await pool.query(
      'DELETE FROM contact_messages WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)',
      [months]
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} old contact messages`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge messages error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge failed/expired donations ───
router.post('/donations', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM donations WHERE status IN ('failed', 'expired') AND created_at < DATE_SUB(NOW(), INTERVAL 1 MONTH)"
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} failed/expired donations`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge donations error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge expired memberships ───
router.post('/memberships', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM memberships WHERE status = 'expired' AND created_at < DATE_SUB(NOW(), INTERVAL 1 MONTH)"
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} expired memberships`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge memberships error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge non-approved comments ───
router.post('/comments', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM comments WHERE approved = 0'
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} non-approved comments`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge comments error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge old newsletter send logs ───
router.post('/newsletters', authenticate, requireAdmin, async (req, res) => {
  try {
    const { months = 12 } = req.body;
    const [result] = await pool.query(
      'DELETE FROM newsletter_sends WHERE sent_at < DATE_SUB(NOW(), INTERVAL ? MONTH)',
      [months]
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} old newsletter send logs`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge newsletters error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge old social post logs ───
router.post('/social-logs', authenticate, requireAdmin, async (req, res) => {
  try {
    const { months = 6 } = req.body;
    const [result] = await pool.query(
      'DELETE FROM social_posts_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)',
      [months]
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} old social post logs`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge social logs error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge expired password reset codes ───
router.post('/password-resets', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM password_resets WHERE expires_at < NOW()'
    ) as any;
    console.log(`🧹 Purged ${result.affectedRows} expired password reset codes`);
    res.json({ deleted: result.affectedRows });
  } catch (error) {
    console.error('Purge password resets error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Purge ALL cleanable data at once ───
router.post('/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { articleMonths = 12, eventMonths = 6, messageMonths = 6 } = req.body;
    const results: Record<string, number> = {};

    // Old articles
    const [r1] = await pool.query(
      'DELETE FROM articles WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)', [articleMonths]
    ) as any;
    results.articles = r1.affectedRows;

    // Past events
    const [r2] = await pool.query(
      'DELETE FROM events WHERE event_date < DATE_SUB(CURDATE(), INTERVAL ? MONTH)',
      [eventMonths]
    ) as any;
    results.events = r2.affectedRows;

    // Old messages
    const [r3] = await pool.query(
      'DELETE FROM contact_messages WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MONTH)', [messageMonths]
    ) as any;
    results.messages = r3.affectedRows;

    // Failed/expired donations (>1 month)
    const [r4] = await pool.query(
      "DELETE FROM donations WHERE status IN ('failed', 'expired') AND created_at < DATE_SUB(NOW(), INTERVAL 1 MONTH)"
    ) as any;
    results.donations = r4.affectedRows;

    // Expired memberships (>1 month)
    const [r5] = await pool.query(
      "DELETE FROM memberships WHERE status = 'expired' AND created_at < DATE_SUB(NOW(), INTERVAL 1 MONTH)"
    ) as any;
    results.memberships = r5.affectedRows;

    // Non-approved comments
    const [r6] = await pool.query('DELETE FROM comments WHERE approved = 0') as any;
    results.comments = r6.affectedRows;

    // Expired password resets
    const [r7] = await pool.query('DELETE FROM password_resets WHERE expires_at < NOW()') as any;
    results.passwordResets = r7.affectedRows;

    const total = Object.values(results).reduce((a, b) => a + b, 0);
    console.log(`🧹 Full cleanup: ${total} records purged`, results);

    res.json({ total, details: results });
  } catch (error) {
    console.error('Full cleanup error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
