import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate } from '../middleware/auth';

const router = Router();

// Ensure upload directories exist
const uploadsDir = path.join(process.cwd(), 'uploads');
const dirs = ['images', 'documents', 'avatars'];
dirs.forEach(dir => {
  const fullPath = path.join(uploadsDir, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const type = (req.query.type as string) || 'images';
    const dir = dirs.includes(type) ? type : 'images';
    cb(null, path.join(uploadsDir, dir));
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non autorisé'));
    }
  },
});

// POST /api/upload
router.post('/', authenticate, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }
    const type = (req.query.type as string) || 'images';
    const dir = dirs.includes(type) ? type : 'images';
    const url = `/uploads/${dir}/${req.file.filename}`;
    res.json({ url, filename: req.file.originalname });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/upload
router.delete('/', authenticate, (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requis' });
    
    const filePath = path.join(process.cwd(), url);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ message: 'Fichier supprimé' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
