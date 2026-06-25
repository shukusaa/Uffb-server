const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();

const app = express(); // DOIT être avant tout app.use

// ===== COUCHE SÉCURITÉ HÉBERGEMENT =====
app.use(helmet());
app.use(compression());

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

// ===== TEST SERVEUR =====
app.get('/', (req, res) => {
  res.json({ 
    status: 'UFFB Server OK ✅', 
    ia: IA_CONFIG ? IA_CONFIG.conseil() : 'IA pas encore chargée',
    port: PORT || process.env.PORT || 3000
  });
});

// ===== MONGODB =====
// ===== MONGODB =====
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('MongoDB OK ✅ Connecté à uffb_db'))
  .catch(e => {
    console.log('MongoDB ERREUR:', e.message);
    process.exit(1);
  });

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
  projets: [],
  rythme: 'normal',
  apprendre: function(action, data) {
    this.projets.push({ action, data, date: new Date() });
    if(this.projets.length > 50) this.projets.shift();
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
  try {
    const produits = await Produit.find().sort({ createdAt: -1 });
    res.json(produits);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// STATS DASHBOARD
app.get('/api/stats', async (req, res) => {
  try {
    const db = client.db('uffb');
    const [cmds, produits] = await Promise.all([
      db.collection('commandes').countDocuments(),
      db.collection('produits').countDocuments()
    ]);
    const clients = [...new Set((await db.collection('commandes').find().toArray()).map(c=>c.clientTel))].length;
    const ventes = await db.collection('commandes').aggregate([
      {$match: {date: {$gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)}}},
      {$group: {_id: null, total: {$sum: '$total'}}}
    ]).toArray();
    res.json({commandes: cmds, produits, clients, ventes: ventes[0]?.total || 0});
  } catch(e) {res.status(500).json({error: e.message})}
});

// PRODUITS CRUD
app.get('/api/produits', async (req, res) => {
  const produits = await client.db('uffb').collection('produits').find().toArray();
  res.json(produits);
});
app.post('/api/produits', async (req, res) => {
  const result = await client.db('uffb').collection('produits').insertOne({...req.body, date: new Date()});
  res.json(result);
});
app.put('/api/produits/:id', async (req, res) => {
  const {ObjectId} = require('mongodb');
  const result = await client.db('uffb').collection('produits').updateOne({_id: new ObjectId(req.params.id)}, {$set: req.body});
  res.json(result);
});
app.delete('/api/produits/:id', async (req, res) => {
  const {ObjectId} = require('mongodb');
  const result = await client.db('uffb').collection('produits').deleteOne({_id: new ObjectId(req.params.id)});
  res.json(result);
});

// COMMANDES + CHAT
app.get('/api/commandes', async (req, res) => {
  const cmds = await client.db('uffb').collection('commandes').find().sort({date: -1}).toArray();
  res.json(cmds);
});
app.get('/api/chat', async (req, res) => {
  const msgs = await client.db('uffb').collection('chat').find({tel: req.query.tel}).sort({date: 1}).toArray();
  res.json(msgs);
});
app.post('/api/chat', async (req, res) => {
  await client.db('uffb').collection('chat').insertOne({...req.body, date: new Date()});
  res.json({ok: true});

app.post('/api/produits', async (req, res) => {
  try {
    const p = new Produit(req.body);
    await p.save();
    IA_CONFIG.apprendre('produit_ajout', p.nom);
    res.json(p);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/produits/:id', async (req, res) => {
  try {
    await Produit.findByIdAndDelete(req.params.id); // ✅ CORRIGÉ ICI
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API COMMANDES =====
app.post('/api/commandes', async (req, res) => {
  try {
    const c = new Commande(req.body);
    await c.save();
    IA_CONFIG.apprendre('commande', c.total);
    res.json(c);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/commandes', async (req, res) => {
  try {
    const commandes = await Commande.find().sort({ date: -1 });
    res.json(commandes);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/commandes/:id', async (req, res) => {
  try {
    const c = await Commande.findById(req.params.id);
    res.json(c);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== UPLOAD PHOTO =====
app.post('/api/upload', upload.single('photo'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

// ===== CHAT =====
app.post('/api/chat', async (req, res) => {
  try {
    const msg = new Chat({ ...req.body, date: new Date() });
    await msg.save();
    IA_CONFIG.apprendre('chat', req.body.from);
    res.json(msg);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat/:tel', async (req, res) => {
  try {
    const msgs = await Chat.find({ tel: req.params.tel }).sort({ date: 1 });
    res.json(msgs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SÉCURITÉ SUPPLÉMENTAIRE =====
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur UFFB lancé sur port ${PORT}`);
  console.log(`IA Rythme actuel: ${IA_CONFIG.conseil()}`);
});
