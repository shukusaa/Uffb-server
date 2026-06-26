const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
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
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Seulement images autorisées'));
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

// ===== SCHEMAS CORRIGÉS =====
const ProduitSchema = new mongoose.Schema({
  nom: String,
  prix: Number,
  stock: Number,
  cat: { type: String, default: 'plomberie' }, // AJOUTÉ pour filtrage
  img: String,
  poids: { type: Number, default: 1 },
  gros: String, // "50:12,100:10.5"
  createdAt: { type: Date, default: Date.now }
});

const CommandeSchema = new mongoose.Schema({
  clientTel: String,
  clientNom: String,
  quartier: String, // AJOUTÉ
  adresse: String, // AJOUTÉ
  zone: String, // AJOUTÉ
  mode: String, // AJOUTÉ cash/momo/airtel/orange
  produits: Array,
  sousTotal: Number,
  fraisLiv: Number,
  total: Number,
  statut: { type: String, default: 'En attente' },
  date: { type: Date, default: Date.now }
});

const ChatSchema = new mongoose.Schema({
  tel: String,
  nom: String,
  from: String, // client, admin, ia
  text: String,
  img: String,
  date: { type: Date, default: Date.now }
});

const ConfigSchema = new mongoose.Schema({
  key: String,
  value: mongoose.Schema.Types.Mixed
});

const Produit = mongoose.model('Produit', ProduitSchema);
const Commande = mongoose.model('Commande', CommandeSchema);
const Chat = mongoose.model('Chat', ChatSchema);
const Config = mongoose.model('Config', ConfigSchema);

// ===== IA V1 ADAPTATIVE =====
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
    const commandes = last10.filter(p => p.action ==='commande').length;
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

// ===== IA V2 GEMINI =====
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const IA_V2_ENABLED =!!GEMINI_KEY;
const genAI = IA_V2_ENABLED? new GoogleGenerativeAI(GEMINI_KEY) : null;
const model = IA_V2_ENABLED? genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }) : null;
async function repondreIA(messageClient, tel) {
  if(!IA_V2_ENABLED) return "Merci pour ton message! Un agent UFFB te répond vite.";

  try {
    const prompt = `Tu es l'assistant UFFB Mobile, quincaillerie à Bunia RDC.
Règle: Réponds court, pro, en français simple. Prix en USD.
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

// ===== ROUTES BASE =====
app.get('/', (req, res) => {
  res.json({
    status: 'UFFB Server OK ✅',
    ia_v1: IA_CONFIG.conseil(),
    ia_v2: IA_V2_ENABLED? 'Gemini Pro Actif' : 'Désactivé - Ajoute GEMINI_API_KEY',
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

// ===== STATS - 1 SEULE ROUTE =====
app.get('/api/stats', async (req, res) => {
  try {
    const [cmds, produits, clients] = await Promise.all([
      Commande.countDocuments(),
      Produit.countDocuments(),
      Commande.distinct('clientTel').then(arr => arr.length)
    ]);
    const debutMois = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const ventes = await Commande.aggregate([
      {$match: {date: {$gte: debutMois}, statut: {$ne: 'Annulée'}}},
      {$group: {_id: null, total: {$sum: '$total'}}}
    ]);
    res.json({
      commandes: cmds,
      produits,
      clients,
      ventes: ventes[0]?.total || 0
    });
  } catch(e) {
    res.status(500).json({error: e.message})
  }
});

// ===== PRODUITS =====
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

// ===== COMMANDES =====
app.post('/api/commandes', async (req, res) => {
  try {
    const c = new Commande(req.body);
    await c.save();
    IA_CONFIG.apprendre('commande', c.total);
    res.json(c);
  } catch(e) {res.status(500).json({ error: e.message });
  }
});

app.get('/api/commandes', async (req, res) => {
  try {
    const tel = req.query.tel;
    const query = tel? { clientTel: tel } : {};
    const commandes = await Commande.find(query).sort({ date: -1 });
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

app.put('/api/commandes/:id', async (req, res) => {
  try {
    await Commande.findByIdAndUpdate(req.params.id, req.body);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== UPLOAD =====
app.post('/api/upload', upload.single('photo'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

// ===== CHAT =====
app.post('/api/chat', async (req, res) => {
  try {
    const msg = new Chat({...req.body, date: new Date() });
    await msg.save();
    IA_CONFIG.apprendre('chat', req.body.from);

    // IA auto-reply si client écrit
    if(req.body.from === 'client' && IA_V2_ENABLED) {
      const config = await Config.findOne({ key: 'gemini_enabled' });
      if(config?.value) {
        setTimeout(async () => {
          await repondreIA(req.body.text, req.body.tel);
        }, 1000);
      }
    }

    res.json(msg);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat', async (req, res) => {
  try {
    const tel = req.query.tel;
    const msgs = await Chat.find({ tel }).sort({ date: 1 });
    res.json(msgs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Liste conversations pour admin - MANQUAIT
app.get('/api/chat/liste', async (req, res) => {
  try {
    const msgs = await Chat.aggregate([
      { $sort: { date: -1 } },
      { $group: {
        _id: "$tel",
        tel: { $first: "$tel" },
        nom: { $first: "$nom" },
        lastMsg: { $first: "$text" },
        lastDate: { $first: "$date" }
      }},
      { $sort: { lastDate: -1 } }
    ]);
    res.json(msgs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== IA V1 PREDICTION STOCK - MANQUAIT =====
app.get('/api/predict-stock', async (req, res) => {
  try {
    const produits = await Produit.find();
    const commandes = await Commande.find();

    const predictions = produits.map(p => {
      const ventes30j = commandes
       .filter(c => {
          const diff = (new Date() - new Date(c.date)) / (1000*60*60*24);
          return diff <= 30;
        })
       .reduce((total, c) => {
          const prod = c.produits.find(pr => pr.nom == p.nom);
          return total + (prod? prod.qty : 0);
        }, 0);

      const venteMoyJour = ventes30j / 30 || 0.1;
      const joursRestants = venteMoyJour > 0? Math.floor(p.stock / venteMoyJour) : 999;

      let risque = 'bas';
      if (joursRestants < 7) risque = 'haut';
      else if (joursRestants < 15) risque = 'moyen';

      return {
        _id: p._id,
        nom: p.nom,
        stockActuel: p.stock,
        venteMoyJour: venteMoyJour.toFixed(2),
        joursRestants: joursRestants,
        risque: risque
      };
    }).filter(p => p.risque!= 'bas').sort((a, b) => a.joursRestants - b.joursRestants);

    res.json(predictions);
  } catch(e) {
    res.json([]);
  }
});

// ===== IA V2 GEMINI ROUTES - MANQUAIENT =====
app.post('/api/gemini-toggle', async (req, res) => {
  await Config.findOneAndUpdate(
    { key: 'gemini_enabled' },
    { value: req.body.enabled },
    { upsert: true }
  );
  res.json({ ok: true });
});

app.post('/api/gemini-test', async (req, res) => {
  if(!IA_V2_ENABLED) return res.json({ reponse: "Gemini désactivé" });
  try {
    const { prompt } = req.body;
    const contexte = "Tu es assistant UFFB Mobile, quincaillerie à Goma RDC. Réponds court, pro, en français.";
    const result = await model.generateContent(contexte + "\nQuestion: " + prompt);
    const response = await result.response.text();
    res.json({ reponse: response });
  } catch(e) {
    res.json({ reponse: "Erreur Gemini: " + e.message });
  }
});

app.post('/api/gemini-reply', async (req, res) => {
  if(!IA_V2_ENABLED) return res.json({ ok: false });
  try {
    const { tel } = req.body;
    const msgs = await Chat.find({ tel }).sort({ date: -1 }).limit(5);
    if (msgs.length == 0 || msgs[0].from!= 'client') return res.json({ ok: false });

    const historique = msgs.reverse().map(m => `${m.from}: ${m.text}`).join('\n');
    const prompt = `Tu es assistant UFFB Mobile quincaillerie Goma. Réponds au client de façon courte et pro en français. Contexte: ${historique}`;

    const result = await model.generateContent(prompt);
    const reponse = await result.response.text();

    await Chat.create({ tel, from: 'ia', text: reponse, date: new Date() });
    res.json({ ok: true, reponse });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== IA V2 INSIGHTS VENTES - MANQUAIT =====
app.get('/api/insights-ventes', async (req, res) => {
  try {
    const commandes = await Commande.find();
    const produits = await Produit.find();

    const catCount = {};
    commandes.forEach(c => {
      c.produits.forEach(p => {
        const prod = produits.find(pr => pr.nom == p.nom);
        if (prod) catCount[prod.cat] = (catCount[prod.cat] || 0) + p.qty;
      });
    });
    const topCat = Object.keys(catCount).reduce((a, b) => catCount[a] > catCount[b]? a : b, 'electricite');

    const prodCount = {};
    commandes.forEach(c => c.produits.forEach(p => {
      prodCount[p.nom] = (prodCount[p.nom] || 0) + p.qty;
    }));
    const topProduit = Object.keys(prodCount).reduce((a, b) => prodCount[a] > prodCount[b]? a : b, 'Câble');

    if(IA_V2_ENABLED) {
      const stats = `Top catégorie: ${topCat}, Top produit: ${topProduit}, Total commandes: ${commandes.length}`;
      const prompt = `Analyse ces données ventes UFFB Mobile Goma: ${stats}. Donne 1 conseil business court + prédiction ventes mois prochain. 3 lignes max.`;
      const result = await model.generateContent(prompt);
      const analyse = await result.response.text();

      res.json({
        topCat,
        topProduit,
        conseil: analyse.split('\n')[0] || 'Stocke plus top catégorie',
        prediction: analyse.split('\n')[1] || '+15% ventes prévu'
      });
    } else {
      res.json({
        topCat, topProduit,
        conseil: 'Active Gemini pour analyse IA',
        prediction: '+10% ventes prévu'
      });
    }
  } catch(e) {
    res.json({ topCat: 'electricite', topProduit: 'Câble', conseil: 'Erreur analyse', prediction: 'N/A' });
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
  console.log(`IA V2 Gemini: ${IA_V2_ENABLED? 'ACTIF' : 'OFF'}`);
});
