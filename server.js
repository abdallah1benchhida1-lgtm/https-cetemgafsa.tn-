const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

let broadcasterId = null;
const users = new Map();

function heureNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Africa/Tunis'
    });
}

app.get('/', (req, res) => res.send('✅ Serveur WebRTC opérationnel'));

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

        socket.emit('existing-users', {
            users: Array.from(users.values()),
            total: users.size
        });

        io.emit('user-joined', {
            ...user,
            participantsList: Array.from(users.values())
        });

        // Si formateur déjà en ligne → notifier ce participant
        // Petit délai pour que le client soit prêt à recevoir
        if (broadcasterId && user.role === 'participant') {
            setTimeout(() => {
                socket.emit('broadcaster-ready', broadcasterId);
            }, 500);
        }
    });

    // ─── Formateur broadcaster ────────────────────────────────
    socket.on('broadcaster', () => {
        broadcasterId = socket.id;
        console.log(`🎥 Formateur broadcaster : ${socket.id}`);
        // Notifier tous les participants avec délai
        setTimeout(() => {
            socket.broadcast.emit('broadcaster-ready', socket.id);
        }, 300);
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

    socket.on('cam-request', () => {
        const user = users.get(socket.id);
        if (!user || !broadcasterId) return;
        io.to(broadcasterId).emit('cam-request', {
            socketId: socket.id,
            nom: user.nom
        });
    });

    socket.on('cam-approved', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-approved');
    });

    socket.on('cam-rejected', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-rejected');
    });

    socket.on('cam-stop', (participantSocketId) => {
        io.to(participantSocketId).emit('cam-stopped-by-formateur');
    });

    socket.on('p-offer', (target, desc) => {
        const dest = target === 'formateur' ? broadcasterId : target;
        if (dest) io.to(dest).emit('p-offer', socket.id, desc);
    });

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
