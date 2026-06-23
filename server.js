const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();

const app = express(); // <-- DOIT être avant tout app.use

// ===== COUCHE SÉCURITÉ HÉBERGEMENT =====
app.use(helmet()); // Protège headers HTTP
app.use(compression()); // Compresse réponses

// Anti-brute force : max 100 requêtes / 15min par IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessaie dans 15min' }
});
app.use('/api/', limiter);

// Anti upload massif : max 5MB photo
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) 
      return cb(new Error('Seulement images autorisées'));
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Sert dossier uploads avec chemin absolu
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===== MONGODB =====
mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/uffb')
  .then(() => console.log('MongoDB OK'))
  .catch(e => console.log('MongoDB ERREUR:', e));

// ===== SCHEMAS =====
const Produit = mongoose.model('Produit', {
  nom: String, prix: Number, stock: Number, 
  img: String, createdAt: { type: Date, default: Date.now }
});

const Commande = mongoose.model('Commande', {
  clientTel: String, clientNom: String, produits: Array,
  sousTotal: Number, fraisLiv: Number, total: Number,
  statut: { type: String, default: 'En attente' },
  date: { type: Date, default: Date.now }
});

const Chat = mongoose.model('Chat', {
  tel: String, from: String, text: String, img: String, date: Date
});

// ===== IA ADAPTATIVE "UFFB BRAIN" =====
const IA_CONFIG = {
  projets: [], // Le serveur apprend tes projets ici
  rythme: 'normal', // normal | rush | maintenance
  apprendre: function(action, data) {
    this.projets.push({ action, data, date: new Date() });
    if(this.projets.length > 50) this.projets.shift(); // garde 50 derniers
    this.ajusterRythme();
    console.log(`[IA] Action apprise: ${action}`);
  },
  ajusterRythme: function() {
    const last10 = this.projets.slice(-10);
    const commandes = last10.filter(p => p.action === 'commande').length;
    if(commandes >= 5) this.rythme = 'rush';
    else if(commandes === 0) this.rythme = 'maintenance';
    else this.rythme = 'normal';
  },
  conseil: function() {
    if(this.rythme === 'rush') return 'Mode rush: Activer cache + limiter chat';
    if(this.rythme === 'maintenance') return 'Mode calme: Faire backup MongoDB';
    return 'Mode normal: Tout OK';
  }
};

// Route pour que l’IA te parle
app.get('/api/ia/status', (req, res) => {
  res.json({ 
    rythme: IA_CONFIG.rythme, 
    conseil: IA_CONFIG.conseil(),
    projets_analyses: IA_CONFIG.projets.length 
  });
});

// ===== API PRODUITS =====
app.get('/api/produits', async (req, res) => {
  const produits = await Produit.find().sort({ createdAt: -1 });
  res.json(produits);
});

app.post('/api/produits', async (req, res) => {
  const p = new Produit(req.body);
  await p.save();
  IA_CONFIG.apprendre('produit_ajout', p.nom);
  res.json(p);
});

app.delete('/api/produits/:id', async (req, res) => {
  await Produit.findByIdAndDelete(req.id);
  res.json({ ok: true });
});

// ===== API COMMANDES =====
app.post('/api/commandes', async (req, res) => {
  const c = new Commande(req.body);
  await c.save();
  IA_CONFIG.apprendre('commande', c.total);
  res.json(c);
});

app.get('/api/commandes', async (req, res) => {
  const commandes = await Commande.find().sort({ date: -1 });
  res.json(commandes);
});

app.get('/api/commandes/:id', async (req, res) => {
  const c = await Commande.findById(req.params.id);
  res.json(c);
});

// ===== UPLOAD PHOTO =====
app.post('/api/upload', upload.single('photo'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

// ===== CHAT =====
app.post('/api/chat', async (req, res) => {
  const msg = new Chat({ ...req.body, date: new Date() });
  await msg.save();
  IA_CONFIG.apprendre('chat', req.body.from);
  res.json(msg);
});

app.get('/api/chat/:tel', async (req, res) => {
  const msgs = await Chat.find({ tel: req.params.tel }).sort({ date: 1 });
  res.json(msgs);
});

// ===== SÉCURITÉ SUPPLÉMENTAIRE =====
// Cache les erreurs serveur en prod
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Serveur UFFB port ${PORT}`));
