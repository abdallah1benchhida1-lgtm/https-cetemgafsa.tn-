const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ─── État global ─────────────────────────────────────────────
let broadcasterId = null;          // Socket ID du formateur
const users       = new Map();     // Tous les utilisateurs connectés

// ─── Heure formatée ──────────────────────────────────────────
function heureNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour:   '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Africa/Tunis'
    });
}

// ─── Health check pour Render ────────────────────────────────
app.get('/', (req, res) => res.send('✅ Serveur WebRTC opérationnel'));

// ═══════════════════════════════════════════════════════════════
// 🔌 SOCKET.IO
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`🔌 Connexion : ${socket.id}`);

    // ─── Rejoindre le chat ────────────────────────────────────
    socket.on('join-chat', (data) => {
        const user = {
            socketId:         socket.id,
            nom:              data.nom              || 'Anonyme',
            email:            data.email            || '',
            etablissement:    data.etablissement    || '',
            fonction:         data.fonction         || '',
            role:             data.role             || 'participant',
            heureConnexion:   heureNow(),
            heureDeconnexion: null
        };
        users.set(socket.id, user);

        // Envoyer aux nouveaux participants la liste existante
        socket.emit('existing-users', {
            users: Array.from(users.values()),
            total: users.size
        });

        // Notifier tout le monde
        io.emit('user-joined', {
            ...user,
            participantsList: Array.from(users.values())
        });

        // Si le formateur est déjà en ligne, notifier ce participant
        if (broadcasterId && user.role === 'participant') {
            socket.emit('broadcaster-ready', broadcasterId);
        }

        console.log(`👤 ${user.nom} (${user.role}) connecté`);
    });

    // ─── Formateur démarre la diffusion ──────────────────────
    socket.on('broadcaster', () => {
        broadcasterId = socket.id;
        console.log(`🎥 Formateur broadcaster : ${socket.id}`);

        // Notifier TOUS les participants que le formateur est prêt
        socket.broadcast.emit('broadcaster-ready', socket.id);
    });

    // ─── Participant veut regarder ────────────────────────────
    socket.on('watcher', () => {
        if (broadcasterId && broadcasterId !== socket.id) {
            // Notifier le formateur qu'un participant veut se connecter
            io.to(broadcasterId).emit('watcher', socket.id);
        } else {
            // Pas encore de formateur — on attend
            socket.emit('no-broadcaster');
        }
    });

    // ─── Signaling WebRTC ─────────────────────────────────────
    socket.on('offer', (id, description) => {
        io.to(id).emit('offer', socket.id, description);
    });

    socket.on('answer', (id, description) => {
        io.to(id).emit('answer', socket.id, description);
    });

    socket.on('candidate', (id, candidate) => {
        io.to(id).emit('candidate', socket.id, candidate);
    });

    // ─── Chat ─────────────────────────────────────────────────
    socket.on('chat-message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        io.emit('new-message', {
            nom:       user.nom,
            role:      user.role,
            message:   data.message,
            timestamp: heureNow()
        });
    });

    // ─── Lever la main ────────────────────────────────────────
    socket.on('raise-hand', () => {
        const user = users.get(socket.id);
        if (!user) return;

        io.emit('hand-raised', {
            nom:       user.nom,
            timestamp: heureNow()
        });
    });

    // ─── Déconnexion ─────────────────────────────────────────
    socket.on('disconnect', () => {
        const user = users.get(socket.id);

        if (user) {
            user.heureDeconnexion = heureNow();
            console.log(`👋 ${user.nom} déconnecté à ${user.heureDeconnexion}`);

            users.delete(socket.id);

            io.emit('user-left', {
                ...user,
                participantsList: Array.from(users.values())
            });
        }

        // Si c'était le formateur
        if (socket.id === broadcasterId) {
            broadcasterId = null;
            console.log('🔴 Formateur déconnecté');
            io.emit('broadcaster-disconnected');
        } else {
            // Notifier le formateur que ce participant est parti
            if (broadcasterId) {
                io.to(broadcasterId).emit('disconnectPeer', socket.id);
            }
        }
    });
});

// ─── Démarrage ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
