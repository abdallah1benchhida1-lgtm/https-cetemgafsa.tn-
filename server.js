// ═══════════════════════════════════════════════════════════════
// SERVEUR SOCKET.IO — Formation en ligne CETEM GAFSA
// Version 2.1 — Salles par roomCode + Force-kick + Rate limiting
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    pingTimeout:  60000,
    pingInterval: 25000,
});

// 🔑 Secret pour /force-kick
const KICK_SECRET = process.env.KICK_SECRET || 'cetem_kick_2026';

// ⏱️ Rate limiting
const messageRateLimiter = new Map(); // socketId → lastTimestamp
const RATE_LIMIT_MS = 500;

// ── État global ────────────────────────────────────────────────
// rooms    : Map<roomCode, { broadcasterId: string|null, users: Map<socketId, user> }>
// emailToSocket : Map<email, socketId>  (global, pour force-kick)
const rooms         = new Map();
const emailToSocket = new Map();
// socketToRoom : Map<socketId, roomCode>  (raccourci)
const socketToRoom  = new Map();

app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────
function heureNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Africa/Tunis'
    });
}

function logEvent(level, message) {
    console.log(`[${new Date().toISOString()}] ${level} ${message}`);
}

function getOrCreateRoom(roomCode) {
    if (!rooms.has(roomCode)) {
        rooms.set(roomCode, {
            broadcasterId: null,
            users: new Map(),
        });
    }
    return rooms.get(roomCode);
}

function cleanRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (room && room.users.size === 0) {
        rooms.delete(roomCode);
        logEvent('🧹', `Salle ${roomCode} supprimée (vide)`);
    }
}

// ── Routes HTTP ────────────────────────────────────────────────
app.get('/', (req, res) => res.send('✅ Serveur CETEM Formation opérationnel'));

app.get('/health', (req, res) => res.json({
    ok: true,
    rooms: rooms.size,
    totalUsers: Array.from(rooms.values()).reduce((s, r) => s + r.users.size, 0),
    uptime: process.uptime()
}));

// ═══════════════════════════════════════════════════════════════
// 🚫 FORCE-KICK : appelé par PHP quand un code est révoqué
//    POST /force-kick   { secret, email }
// ═══════════════════════════════════════════════════════════════
app.post('/force-kick', (req, res) => {
    const { secret, email } = req.body || {};

    if (secret !== KICK_SECRET) {
        logEvent('⚠️', 'Force-kick tentée avec secret invalide');
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

    io.to(socketId).emit('force-kicked', {
        message: '🚫 Votre accès a été révoqué par l\'administrateur. La session va se fermer.'
    });

    setTimeout(() => {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
            logEvent('🚫', `Socket ${socketId} déconnecté par force-kick`);
            sock.disconnect(true);
        }
    }, 2000);

    logEvent('🚫', `Force-kick appliqué: ${email} (socket ${socketId})`);
    return res.json({ ok: true, message: `Utilisateur ${email} kické avec succès` });
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    logEvent('🔌', `Nouvelle connexion: ${socket.id}`);

    // ── join-room (nouveau) ET join-chat (rétrocompatibilité) ──
    function handleJoin(data) {
        try {
            if (!data || typeof data !== 'object') return;

            const nom           = String(data.nom           || 'Anonyme').substring(0, 100);
            const email         = String(data.email         || '').substring(0, 255).toLowerCase();
            const etablissement = String(data.etablissement || '').substring(0, 255);
            const fonction      = String(data.fonction      || '').substring(0, 255);
            const role          = String(data.role          || 'participant').substring(0, 50);
            // roomCode = salle de formation explicite uniquement
            // IMPORTANT: data.code est le code d'accès PERSONNEL du participant
            // → ne jamais l'utiliser comme roomCode (sinon chaque participant est dans sa propre salle)
            const roomCode      = String(data.roomCode || 'default').substring(0, 20);

            // Gestion doublons email
            if (email) {
                const oldSocketId = emailToSocket.get(email);
                if (oldSocketId && oldSocketId !== socket.id) {
                    logEvent('⚠️', `Doublon email ${email} — kick ancien socket ${oldSocketId}`);
                    const oldSock = io.sockets.sockets.get(oldSocketId);
                    if (oldSock) {
                        oldSock.emit('force-kicked', {
                            message: '🔄 Vous êtes connecté ailleurs. Cette session va se fermer.'
                        });
                        setTimeout(() => oldSock.disconnect(true), 1000);
                    }
                    // Retirer l'ancien socket de sa salle
                    const oldRoom = socketToRoom.get(oldSocketId);
                    if (oldRoom) {
                        const r = rooms.get(oldRoom);
                        if (r) r.users.delete(oldSocketId);
                        socketToRoom.delete(oldSocketId);
                    }
                }
            }

            const user = {
                socketId:       socket.id,
                nom,
                email,
                etablissement,
                fonction,
                role,
                roomCode,
                heureConnexion:    heureNow(),
                heureDeconnexion:  null,
            };

            // Rejoindre la salle Socket.io
            socket.join(roomCode);
            socketToRoom.set(socket.id, roomCode);

            const room = getOrCreateRoom(roomCode);
            room.users.set(socket.id, user);

            if (email) emailToSocket.set(email, socket.id);

            logEvent('✅', `${nom} (${role}) rejoint salle [${roomCode}]`);

            // Envoyer la liste des utilisateurs déjà présents dans la salle
            socket.emit('existing-users', {
                users: Array.from(room.users.values()),
                total: room.users.size
            });

            // Informer toute la salle
            io.in(roomCode).emit('user-joined', {
                ...user,
                participantsList: Array.from(room.users.values())
            });

            // Si broadcaster déjà actif → informer le nouvel arrivant
            if (room.broadcasterId && role === 'participant') {
                socket.emit('broadcaster-ready', room.broadcasterId);
            }

        } catch (error) {
            logEvent('❌', `Erreur join: ${error.message}`);
        }
    }

    socket.on('join-room',  handleJoin);   // nouveau
    socket.on('join-chat',  handleJoin);   // rétrocompatibilité

    // ── Broadcaster ────────────────────────────────────────────
    socket.on('broadcaster', (opts) => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            if (!roomCode) return;
            const room = rooms.get(roomCode);
            if (!room) return;

            const wasAlreadyBroadcaster = (room.broadcasterId === socket.id);
            room.broadcasterId = socket.id;
            const user = room.users.get(socket.id);

            // heartbeat : le formateur ré-émet 'broadcaster' régulièrement
            // → on met à jour broadcasterId mais on ne notifie PAS toute la salle
            //   (ce qui déclencherait des re-négociations WebRTC et couperait la vidéo)
            // → on notifie UNIQUEMENT les participants qui n'ont pas encore reçu l'offer
            //   = ceux qui ont un état ICE 'new' ou qui n'ont pas de connexion
            // Côté serveur on ne peut pas savoir ça, donc :
            // - si déjà broadcaster : silent (les connexions actives continuent)
            // - si nouveau broadcaster : notifier tout le monde
            if (!wasAlreadyBroadcaster) {
                logEvent('🎥', `Broadcaster actif: ${user?.nom || socket.id} [${roomCode}]`);
                socket.to(roomCode).emit('broadcaster-ready', socket.id);
            } else {
                logEvent('🔄', `Broadcaster heartbeat: ${user?.nom || socket.id} [${roomCode}]`);
                // Ne rien émettre — les connexions WebRTC existantes continuent sans interruption
            }
        } catch (e) { logEvent('❌', `broadcaster: ${e.message}`); }
    });

    // ── Watcher (participant veut voir) ────────────────────────
    socket.on('watcher', () => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            if (!roomCode) return;
            const room = rooms.get(roomCode);
            if (!room) return;

            if (room.broadcasterId && room.broadcasterId !== socket.id) {
                io.to(room.broadcasterId).emit('watcher', socket.id);
            } else {
                socket.emit('no-broadcaster');
            }
        } catch (e) { logEvent('❌', `watcher: ${e.message}`); }
    });

    // ── Signaling WebRTC formateur → participants ──────────────
    socket.on('offer',     (id, desc) => { try { io.to(id).emit('offer',     socket.id, desc); } catch(e){} });
    socket.on('answer',    (id, desc) => { try { io.to(id).emit('answer',    socket.id, desc); } catch(e){} });
    socket.on('candidate', (id, cand) => { try { io.to(id).emit('candidate', socket.id, cand); } catch(e){} });

    // ── Signaling WebRTC participants → formateur ──────────────
    socket.on('p-offer', (target, desc) => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            const dest     = (target === 'formateur' && room) ? room.broadcasterId : target;
            if (dest) io.to(dest).emit('p-offer', socket.id, desc);
        } catch(e) { logEvent('❌', `p-offer: ${e.message}`); }
    });

    socket.on('p-answer', (target, desc) => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            const dest     = (target === 'formateur' && room) ? room.broadcasterId : target;
            if (dest) io.to(dest).emit('p-answer', socket.id, desc);
        } catch(e) { logEvent('❌', `p-answer: ${e.message}`); }
    });

    socket.on('p-answer-to', (participantSocketId, desc) => {
        try { io.to(participantSocketId).emit('p-answer', socket.id, desc); } catch(e){}
    });

    socket.on('p-candidate', (target, cand) => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            const dest     = (target === 'formateur' && room) ? room.broadcasterId : target;
            if (dest) io.to(dest).emit('p-candidate', socket.id, cand);
        } catch(e) { logEvent('❌', `p-candidate: ${e.message}`); }
    });

    // ── Webcam participant ─────────────────────────────────────
    socket.on('cam-request', () => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            if (!room?.broadcasterId) return;
            const user = room.users.get(socket.id);
            io.to(room.broadcasterId).emit('cam-request', {
                socketId: socket.id,
                nom: user?.nom || 'Participant'
            });
        } catch(e) { logEvent('❌', `cam-request: ${e.message}`); }
    });

    socket.on('cam-approved',          (sid) => { try { io.to(sid).emit('cam-approved');            } catch(e){} });
    socket.on('cam-rejected',          (sid) => { try { io.to(sid).emit('cam-rejected');            } catch(e){} });
    socket.on('cam-stop',              (sid) => { try { io.to(sid).emit('cam-stopped-by-formateur');} catch(e){} });
    socket.on('cam-stopped-by-formateur',(sid)=>{ try { io.to(sid).emit('cam-stopped-by-formateur');} catch(e){} });
    socket.on('cam-blocked-by-formateur',(sid)=>{ try { io.to(sid).emit('cam-blocked-by-formateur');} catch(e){} });
    socket.on('block-participant-cam', (sid) => { try { io.to(sid).emit('cam-blocked-by-formateur');} catch(e){} });

    // ── Main levée ─────────────────────────────────────────────
    socket.on('raise-hand', ({ nom } = {}) => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            if (!room?.broadcasterId) return;
            const user = room.users.get(socket.id);
            io.to(room.broadcasterId).emit('hand-raised', {
                socketId:  socket.id,
                nom:       nom || user?.nom || 'Participant',
                timestamp: heureNow()
            });
        } catch(e) {}
    });

    socket.on('lower-hand', () => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            if (room?.broadcasterId) {
                io.to(room.broadcasterId).emit('hand-lowered-by-participant', socket.id);
            }
        } catch(e) {}
    });

    socket.on('hand-lowered', (sid) => {
        try { io.to(sid).emit('hand-lowered'); } catch(e) {}
    });

    // ── Chat ───────────────────────────────────────────────────
    socket.on('chat-message', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const message = String(data.message || '').trim().substring(0, 500);
            if (!message) return;

            const roomCode = socketToRoom.get(socket.id);
            const room     = roomCode ? rooms.get(roomCode) : null;
            if (!room) return;

            const user = room.users.get(socket.id);
            if (!user) return;

            // Rate limiting
            const now     = Date.now();
            const lastMsg = messageRateLimiter.get(socket.id) || 0;
            if (now - lastMsg < RATE_LIMIT_MS) {
                socket.emit('rate-limited', '⏱️ Trop rapide, attendez...');
                return;
            }
            messageRateLimiter.set(socket.id, now);

            // Nom peut être surchargé (ex. formateur envoie son nom)
            const nom = String(data.nom || user.nom).substring(0, 100);

            io.in(roomCode).emit('new-message', {
                nom,
                role:      user.role,
                message,
                timestamp: heureNow(),
                socketId:  socket.id,
            });

        } catch(e) { logEvent('❌', `chat-message: ${e.message}`); }
    });

    // ── Déconnexion ────────────────────────────────────────────
    socket.on('disconnect', () => {
        try {
            const roomCode = socketToRoom.get(socket.id);
            socketToRoom.delete(socket.id);
            messageRateLimiter.delete(socket.id);

            if (!roomCode) return;
            const room = rooms.get(roomCode);
            if (!room)  return;

            const user = room.users.get(socket.id);
            room.users.delete(socket.id);

            if (user) {
                user.heureDeconnexion = heureNow();
                if (user.email) emailToSocket.delete(user.email);
                logEvent('🔌', `${user.nom} déconnecté de [${roomCode}]`);
                io.in(roomCode).emit('user-left', {
                    ...user,
                    participantsList: Array.from(room.users.values())
                });
            }

            // Broadcaster déconnecté ?
            if (socket.id === room.broadcasterId) {
                logEvent('🎥', `Broadcaster déconnecté de [${roomCode}]`);
                room.broadcasterId = null;
                io.in(roomCode).emit('broadcaster-disconnected');
            } else if (room.broadcasterId) {
                io.to(room.broadcasterId).emit('disconnectPeer', socket.id);
            }

            cleanRoom(roomCode);

        } catch(e) { logEvent('❌', `disconnect: ${e.message}`); }
    });

    socket.on('error', (e) => logEvent('❌', `Socket error (${socket.id}): ${e}`));
});

// ── Démarrage ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logEvent('🚀', `Serveur démarré sur port ${PORT}`);
    logEvent('ℹ️', `Environnement : ${process.env.NODE_ENV || 'development'}`);
});

process.on('uncaughtException',  (e) => logEvent('💥', `Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (r) => logEvent('💥', `Unhandled rejection: ${r}`));
