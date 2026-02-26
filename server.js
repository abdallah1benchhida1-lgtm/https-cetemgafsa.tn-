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

// ⏱️ RATE LIMITING
const messageRateLimiter = new Map(); // socketId → lastTimestamp
const RATE_LIMIT_MS = 500; // Max 1 message par 500ms

app.use(express.json());

function heureNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Africa/Tunis'
    });
}

function logEvent(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level} ${message}`);
}

app.get('/', (req, res) => res.send('✅ Serveur WebRTC opérationnel'));

// ═══════════════════════════════════════════════════════════
// 🚫 FORCE-KICK : appelé par PHP quand un code est révoqué
//    POST /force-kick   { secret, email }
// ═══════════════════════════════════════════════════════════
app.post('/force-kick', (req, res) => {
    const { secret, email } = req.body || {};

    if (secret !== KICK_SECRET) {
        logEvent('⚠️', `Force-kick tentée avec secret invalide`);
        return res.status(403).json({ ok: false, message: 'Secret invalide' });
    }
    if (!email) {
        return res.status(400).json({ ok: false, message: 'Email manquant' });
    }

    const key      = email.toLowerCase();
    const socketId = emailToSocket.get(key);

    if (!socketId) {
        logEvent('ℹ️', `Force-kick pour ${email} — utilisateur non connecté`);
        return res.json({ ok: true, message: 'Utilisateur non connecté (rien à faire)' });
    }

    // Émettre l'événement de kick à ce socket précis
    io.to(socketId).emit('force-kicked', {
        message: '🚫 Votre accès a été révoqué par l\'administrateur. La session va se fermer.'
    });

    // Déconnecter le socket après un court délai
    setTimeout(() => {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
            logEvent('🚫', `Socket ${socketId} disconnecté forcément`);
            sock.disconnect(true);
        }
    }, 2000);

    logEvent('🚫', `Force-kick appliqué: ${email} (socket ${socketId})`);
    return res.json({ ok: true, message: `Utilisateur ${email} kické avec succès` });
});

// ═══════════════════════════════════════════════════════════
// SOCKET.IO EVENTS
// ═══════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    logEvent('🔌', `Nouvelle connexion: ${socket.id}`);

    socket.on('join-chat', (data) => {
        try {
            // Validation des données
            if (!data || typeof data !== 'object') {
                logEvent('⚠️', `join-chat invalide de ${socket.id}`);
                return;
            }

            const nom           = String(data.nom || 'Anonyme').substring(0, 100);
            const email         = String(data.email || '').substring(0, 255).toLowerCase();
            const etablissement = String(data.etablissement || '').substring(0, 255);
            const fonction      = String(data.fonction || '').substring(0, 255);
            const role          = String(data.role || 'participant').substring(0, 50);

            // ✅ FIXE #1: Gestion des doublons d'email
            if (email) {
                const oldSocketId = emailToSocket.get(email);
                if (oldSocketId && oldSocketId !== socket.id) {
                    logEvent('⚠️', `Doublon d'email ${email} — kick ancien socket ${oldSocketId}`);
                    const oldSocket = io.sockets.sockets.get(oldSocketId);
                    if (oldSocket) {
                        oldSocket.emit('force-kicked', {
                            message: '🔄 Vous êtes connecté ailleurs. La session actuelle va se fermer.'
                        });
                        setTimeout(() => oldSocket.disconnect(true), 1000);
                    }
                }
            }

            const user = {
                socketId: socket.id,
                nom: nom,
                email: email,
                etablissement: etablissement,
                fonction: fonction,
                role: role,
                heureConnexion: heureNow(),
                heureDeconnexion: null
            };

            users.set(socket.id, user);
            if (email) emailToSocket.set(email, socket.id);

            logEvent('✅', `${nom} rejoint (${role}) - ${email}`);

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

        } catch (error) {
            logEvent('❌', `Erreur join-chat: ${error.message}`);
        }
    });

    // ─── Formateur broadcaster ────────────────────────────────
    socket.on('broadcaster', () => {
        try {
            broadcasterId = socket.id;
            const user = users.get(socket.id);
            logEvent('🎥', `Broadcaster actif: ${user?.nom || 'Unknown'}`);
            socket.broadcast.emit('broadcaster-ready', socket.id);
        } catch (error) {
            logEvent('❌', `Erreur broadcaster: ${error.message}`);
        }
    });

    // ─── Participant veut regarder ────────────────────────────
    socket.on('watcher', () => {
        try {
            if (broadcasterId && broadcasterId !== socket.id) {
                io.to(broadcasterId).emit('watcher', socket.id);
            } else {
                socket.emit('no-broadcaster');
            }
        } catch (error) {
            logEvent('❌', `Erreur watcher: ${error.message}`);
        }
    });

    // ─── Signaling formateur → participants ───────────────────
    socket.on('offer', (id, desc) => {
        try {
            io.to(id).emit('offer', socket.id, desc);
        } catch (error) {
            logEvent('❌', `Erreur offer: ${error.message}`);
        }
    });

    socket.on('answer', (id, desc) => {
        try {
            io.to(id).emit('answer', socket.id, desc);
        } catch (error) {
            logEvent('❌', `Erreur answer: ${error.message}`);
        }
    });

    socket.on('candidate', (id, cand) => {
        try {
            io.to(id).emit('candidate', socket.id, cand);
        } catch (error) {
            logEvent('❌', `Erreur candidate: ${error.message}`);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // 📷 PARTAGE CAM PARTICIPANT → FORMATEUR
    // ═══════════════════════════════════════════════════════════

    socket.on('cam-request', () => {
        try {
            const user = users.get(socket.id);
            if (!user || !broadcasterId) return;
            io.to(broadcasterId).emit('cam-request', {
                socketId: socket.id,
                nom: user.nom
            });
        } catch (error) {
            logEvent('❌', `Erreur cam-request: ${error.message}`);
        }
    });

    socket.on('cam-approved', (participantSocketId) => {
        try {
            io.to(participantSocketId).emit('cam-approved');
        } catch (error) {
            logEvent('❌', `Erreur cam-approved: ${error.message}`);
        }
    });

    socket.on('cam-rejected', (participantSocketId) => {
        try {
            io.to(participantSocketId).emit('cam-rejected');
        } catch (error) {
            logEvent('❌', `Erreur cam-rejected: ${error.message}`);
        }
    });

    socket.on('cam-stop', (participantSocketId) => {
        try {
            io.to(participantSocketId).emit('cam-stopped-by-formateur');
        } catch (error) {
            logEvent('❌', `Erreur cam-stop: ${error.message}`);
        }
    });

    // ─── Signaling WebRTC participant → formateur ──────────────
    socket.on('p-offer', (target, desc) => {
        try {
            const dest = target === 'formateur' ? broadcasterId : target;
            if (dest) io.to(dest).emit('p-offer', socket.id, desc);
        } catch (error) {
            logEvent('❌', `Erreur p-offer: ${error.message}`);
        }
    });

    socket.on('p-answer', (target, desc) => {
        try {
            const dest = target === 'formateur' ? broadcasterId : target;
            if (dest) io.to(dest).emit('p-answer', socket.id, desc);
            else io.to(target).emit('p-answer', socket.id, desc);
        } catch (error) {
            logEvent('❌', `Erreur p-answer: ${error.message}`);
        }
    });

    socket.on('p-answer-to', (participantSocketId, desc) => {
        try {
            io.to(participantSocketId).emit('p-answer', socket.id, desc);
        } catch (error) {
            logEvent('❌', `Erreur p-answer-to: ${error.message}`);
        }
    });

    socket.on('p-candidate', (target, cand) => {
        try {
            const dest = target === 'formateur' ? broadcasterId : target;
            if (dest) io.to(dest).emit('p-candidate', socket.id, cand);
        } catch (error) {
            logEvent('❌', `Erreur p-candidate: ${error.message}`);
        }
    });

    // ─── Chat ─────────────────────────────────────────────────
    socket.on('chat-message', (data) => {
        try {
            // ✅ FIXE #2: Validation stricte
            if (!data || typeof data !== 'object') return;

            const message = String(data.message || '').trim().substring(0, 500);
            if (!message || message.length < 1) return;

            const user = users.get(socket.id);
            if (!user) return;

            // ✅ FIXE #4: Rate limiting
            const now = Date.now();
            const lastMsg = messageRateLimiter.get(socket.id) || 0;

            if (now - lastMsg < RATE_LIMIT_MS) {
                socket.emit('rate-limited', '⏱️ Trop rapide, attendez...');
                return;
            }

            messageRateLimiter.set(socket.id, now);

            io.emit('new-message', {
                nom: user.nom,
                role: user.role,
                message: message,
                timestamp: heureNow()
            });

        } catch (error) {
            logEvent('❌', `Erreur chat-message: ${error.message}`);
        }
    });

    socket.on('raise-hand', () => {
        try {
            const user = users.get(socket.id);
            if (!user) return;
            io.emit('hand-raised', {
                nom: user.nom,
                timestamp: heureNow()
            });
        } catch (error) {
            logEvent('❌', `Erreur raise-hand: ${error.message}`);
        }
    });

    // ─── Déconnexion ─────────────────────────────────────────
    socket.on('disconnect', () => {
        try {
            const user = users.get(socket.id);
            if (user) {
                user.heureDeconnexion = heureNow();
                logEvent('🔌', `${user.nom} déconnecté (${socket.id})`);
                users.delete(socket.id);
                if (user.email) emailToSocket.delete(user.email);
                
                io.emit('user-left', {
                    ...user,
                    participantsList: Array.from(users.values())
                });
            }

            // ✅ FIXE #3: Gestion correcte du broadcaster orphelin
            if (socket.id === broadcasterId) {
                logEvent('🎥', `Broadcaster déconnecté (${socket.id})`);
                broadcasterId = null;
                io.emit('broadcaster-disconnected');
            } else if (broadcasterId) {
                io.to(broadcasterId).emit('disconnectPeer', socket.id);
            }

            // Nettoyer le rate limiter
            messageRateLimiter.delete(socket.id);

        } catch (error) {
            logEvent('❌', `Erreur disconnect: ${error.message}`);
        }
    });

    // ─── Gestion des erreurs de connexion ─────────────────────
    socket.on('error', (error) => {
        logEvent('❌', `Socket error (${socket.id}): ${error}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logEvent('🚀', `Serveur démarré sur le port ${PORT}`);
    logEvent('ℹ️', `Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
    logEvent('💥', `Uncaught exception: ${error.message}`);
    logEvent('💥', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logEvent('💥', `Unhandled rejection: ${reason}`);
});
