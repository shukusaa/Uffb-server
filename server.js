const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; // PORT déclaré AVANT utilisation

// ===== COUCHE SÉCURITÉ =====
app.use(helmet());
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessaie dans 15min' }
});
app.use('/api/', limiter);

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===== MONGODB =====
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB OK ✅ Connecté'))
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

// ===== IA ADAPTATIVE V1 =====
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

// ===== IA V2 PRO GEMINI =====
const IA_V2_ENABLED = !!process.env.GEMINI_API_KEY;
let GoogleGenerativeAI;
if(IA_V2_ENABLED) {
  try {
    GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
  } catch(e) {
    console.log('Installe: npm install @google/generative-ai');
  }
}

async function repondreIA(messageClient, tel) {
  if(!IA_V2_ENABLED) return "Merci pour ton message! Un agent UFFB te répond vite.";
  
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Tu es l'assistant UFFB, service traiteur à Goma. 
    Règle: Réponds court, chaleureux, en français simple. Propose menu si client demande prix.
    Message client: "${messageClient}"`;
    
    const result = await model.generateContent(prompt);
    const reponse = result.response.text();
    
    await Chat.create({tel, from: 'ia', text: reponse, date: new Date()});
    return reponse;
  } catch(e) {
    console.log('IA V2 Erreur:', e.message);
    return "Merci! L’équipe UFFB te répond dans 2min.";
  }
}

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.json({ 
    status: 'UFFB Server OK ✅', 
    ia_v1: IA_CONFIG.conseil(),
    ia_v2: IA_V2_ENABLED ? 'Gemini Pro Actif' : 'Désactivé - Ajoute GEMINI_API_KEY',
    port: PORT
  });
});

app.get('/api/ia/status', (req, res) => {
  res.json({ 
    rythme: IA_CONFIG.rythme, 
    conseil: IA_CONFIG.conseil(),
    projets_analyses: IA_CONFIG.projets.length,
    ia_v2: IA_V2_ENABLED
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const [cmds, produits, clients] = await Promise.all([
      Commande.countDocuments(),
      Produit.countDocuments(),
      Commande.distinct('clientTel').then(arr => arr.length)
    ]);
    const debutMois = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const ventes = await Commande.aggregate([
      {$match: {date: {$gte: debutMois}}},
      {$group: {_id: null, total: {$sum: '$total'}}}
    ]);
    res.json({commandes: cmds, produits, clients, ventes: ventes[0]?.total || 0});
  } catch(e) {res.status(500).json({error: e.message})}
});

app.get('/api/produits', async (req, res) => {
  try {
    const produits = await Produit.find().sort({ createdAt: -1 });
    res.json(produits);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.put('/api/produits/:id', async (req, res) => {
  try {
    const result = await Produit.findByIdAndUpdate(req.params.id, req.body, {new: true});
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/produits/:id', async (req, res) => {
  try {
    await Produit.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.post('/api/upload', upload.single('photo'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

app.post('/api/chat', async (req, res) => {
  try {
    const msg = new Chat({ ...req.body, date: new Date() });
    await msg.save();
    IA_CONFIG.apprendre('chat', req.body.from);
    
    if(req.body.from === 'client' && IA_V2_ENABLED) {
      setTimeout(async () => {
        const reponseIA = await repondreIA(req.body.text, req.body.tel);
        console.log('[IA V2] Réponse envoyée:', reponseIA);
      }, 1000);
    }
    
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

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`Serveur UFFB lancé sur port ${PORT}`);
  console.log(`IA V1 Rythme: ${IA_CONFIG.conseil()}`);
  console.log(`IA V2 Gemini: ${IA_V2_ENABLED ? 'ACTIF' : 'OFF'}`);
});
