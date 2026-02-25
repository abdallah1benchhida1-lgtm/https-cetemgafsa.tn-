const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

let broadcasterId = null;
const users        = new Map();   // socketId → user
const emailToSocket = new Map();  // email (lowercase) → socketId

// 🔑 Secret partagé entre PHP et Node pour sécuriser /force-kick
const KICK_SECRET = process.env.KICK_SECRET || 'cetem_kick_2026';

app.use(express.json());

function heureNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Africa/Tunis'
    });
}

app.get('/', (req, res) => res.send('✅ Serveur WebRTC opérationnel'));

// ═══════════════════════════════════════════════════════════
// 🚫 FORCE-KICK : appelé par PHP quand un code est révoqué
//    POST /force-kick   { secret, email }
// ═══════════════════════════════════════════════════════════
app.post('/force-kick', (req, res) => {
    const { secret, email } = req.body || {};

    if (secret !== KICK_SECRET) {
        return res.status(403).json({ ok: false, message: 'Secret invalide' });
    }
    if (!email) {
        return res.status(400).json({ ok: false, message: 'Email manquant' });
    }

    const key      = email.toLowerCase();
    const socketId = emailToSocket.get(key);

    if (!socketId) {
        // L'utilisateur n'est pas connecté — rien à faire
        return res.json({ ok: true, message: 'Utilisateur non connecté (rien à faire)' });
    }

    // Émettre l'événement de kick à ce socket précis
    io.to(socketId).emit('force-kicked', {
        message: '🚫 Votre accès a été révoqué par l\'administrateur. La session va se fermer.'
    });

    // Optionnel : déconnecter le socket côté serveur après un court délai
    setTimeout(() => {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) sock.disconnect(true);
    }, 2000);

    console.log(`🚫 Kick forcé : ${email} (socket ${socketId})`);
    return res.json({ ok: true, message: `Utilisateur ${email} kické avec succès` });
});

io.on('connection', (socket) => {
    console.log(`🔌 Connexion : ${socket.id}`);

    socket.on('join-chat', (data) => {
        const user = {
            socketId: socket.id,
            nom: data.nom || 'Anonyme',
            email: data.email || '',
            etablissement: data.etablissement || '',
            fonction: data.fonction || '',
            role: data.role || 'participant',
            heureConnexion: heureNow(),
            heureDeconnexion: null
        };
        users.set(socket.id, user);
        if (user.email) emailToSocket.set(user.email.toLowerCase(), socket.id);

        socket.emit('existing-users', {
            users: Array.from(users.values()),
            total: users.size
        });

        io.emit('user-joined', {
            ...user,
            participantsList: Array.from(users.values())
        });

        if (broadcasterId && user.role === 'participant') {
            socket.emit('broadcaster-ready', broadcasterId);
        }
    });

    // ─── Formateur broadcaster ────────────────────────────────
    socket.on('broadcaster', () => {
        broadcasterId = socket.id;
        socket.broadcast.emit('broadcaster-ready', socket.id);
    });

    // ─── Participant veut regarder ────────────────────────────
    socket.on('watcher', () => {
        if (broadcasterId && broadcasterId !== socket.id) {
            io.to(broadcasterId).emit('watcher', socket.id);
        } else {
            socket.emit('no-broadcaster');
        }
    });

    // ─── Signaling formateur → participants ───────────────────
    socket.on('offer',     (id, desc)  => io.to(id).emit('offer',     socket.id, desc));
    socket.on('answer',    (id, desc)  => io.to(id).emit('answer',    socket.id, desc));
    socket.on('candidate', (id, cand)  => io.to(id).emit('candidate', socket.id, cand));

    // ═══════════════════════════════════════════════════════════
    // 📷 PARTAGE CAM PARTICIPANT → FORMATEUR
    // ═══════════════════════════════════════════════════════════

    // Participant demande à partager sa cam
    socket.on('cam-request', () => {
        const user = users.get(socket.id);
        if (!user || !broadcasterId) return;
        io.to(broadcasterId).emit('cam-request', {
            socketId: socket.id,
            nom: user.nom
        });
    });

    // Formateur accepte → notifie le participant
    socket.on('cam-approved', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-approved');
    });

    // Formateur refuse → notifie le participant
    socket.on('cam-rejected', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-rejected');
    });

    // Formateur arrête la cam du participant
    socket.on('cam-stop', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-stopped-by-formateur');
    });

    // Signaling WebRTC participant → formateur
    // Le participant envoie 'formateur' comme target, on redirige vers broadcasterId
    socket.on('p-offer', (target, desc) => {
        const dest = target === 'formateur' ? broadcasterId : target;
        if (dest) io.to(dest).emit('p-offer', socket.id, desc);
    });

    socket.on('p-answer', (target, desc) => {
        const dest = target === 'formateur' ? broadcasterId : target;
        if (dest) io.to(dest).emit('p-answer', socket.id, desc);
        else io.to(target).emit('p-answer', socket.id, desc);
    });

    // Pour p-answer depuis formateur vers participant : target = participantSocketId
    socket.on('p-answer-to', (participantSocketId, desc) => {
        io.to(participantSocketId).emit('p-answer', socket.id, desc);
    });

    socket.on('p-candidate', (target, cand) => {
        const dest = target === 'formateur' ? broadcasterId : target;
        if (dest) io.to(dest).emit('p-candidate', socket.id, cand);
    });

    // ─── Chat ─────────────────────────────────────────────────
    socket.on('chat-message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        io.emit('new-message', {
            nom: user.nom,
            role: user.role,
            message: data.message,
            timestamp: heureNow()
        });
    });

    socket.on('raise-hand', () => {
        const user = users.get(socket.id);
        if (!user) return;
        io.emit('hand-raised', { nom: user.nom, timestamp: heureNow() });
    });

    // ─── Déconnexion ─────────────────────────────────────────
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            user.heureDeconnexion = heureNow();
            users.delete(socket.id);
            if (user.email) emailToSocket.delete(user.email.toLowerCase());
            io.emit('user-left', {
                ...user,
                participantsList: Array.from(users.values())
            });
        }
        if (socket.id === broadcasterId) {
            broadcasterId = null;
            io.emit('broadcaster-disconnected');
        } else if (broadcasterId) {
            io.to(broadcasterId).emit('disconnectPeer', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));
