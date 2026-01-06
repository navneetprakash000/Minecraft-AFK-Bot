const mineflayer = require('mineflayer');
const autoEat = require('mineflayer-auto-eat').plugin;
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// serve the same index.html for any /a/:id route
app.get('/a/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Basic route redirect to a random session or just instructions
app.get('/', (req, res) => {
    res.redirect('/a/' + Math.random().toString(36).substring(7));
});

// Store sessions: Map<sessionId, { bot: Bot|null, options: Object, ... }>
const sessions = new Map();

function getSession(id) {
    if (!sessions.has(id)) {
        sessions.set(id, {
            id: id,
            bot: null,
            botOptions: {
                host: 'SABKAPAPA3464.feathermc.gg',
                port: 25565,
                username: 'AFK_Bot_' + Math.floor(Math.random() * 1000),
                version: false,
                auth: 'offline'
            },
            reconnectTimeout: null,
            isBotRunning: false,
            logs: [] // Store recent logs to send to new connections
        });
    }
    return sessions.get(id);
}

function log(session, message) {
    const timestamp = new Date().toLocaleTimeString();
    const logMsg = `[${timestamp}] ${message}`;
    console.log(`[${session.id}] ${logMsg}`);

    // Store log history (limit to last 50)
    session.logs.push(logMsg);
    if (session.logs.length > 50) session.logs.shift();

    io.to(session.id).emit('log', logMsg);
}

function createBot(session) {
    if (session.bot) return;

    log(session, `Connecting to ${session.botOptions.host}:${session.botOptions.port} as ${session.botOptions.username}...`);

    try {
        const bot = mineflayer.createBot(session.botOptions);
        session.bot = bot;

        bot.loadPlugin(autoEat);

        bot.on('login', () => {
            log(session, 'Bot logged in!');
            io.to(session.id).emit('status', 'Connected');
            io.to(session.id).emit('bot_info', { username: bot.username });
        });

        bot.on('kicked', (reason) => {
            log(session, `Kicked: ${JSON.stringify(reason)}`);
            cleanupBot(session);
            reconnect(session);
        });

        bot.on('error', (err) => {
            log(session, `Error: ${err.message}`);
            cleanupBot(session);
            reconnect(session);
        });

        bot.on('end', () => {
            log(session, 'Bot disconnected.');
            io.to(session.id).emit('status', 'Disconnected');
            cleanupBot(session);
            reconnect(session);
        });

        bot.on('message', (jsonMsg) => {
            const raw = jsonMsg.toString();
            if (raw.trim().length > 0) {
                log(session, `[CHAT] ${raw}`);
            }
        });

        // Anti-AFK
        bot.on('spawn', () => {
            log(session, 'Bot spawned. Starting AFK routine.');
            startAfkRoutine(session);
        });

    } catch (e) {
        log(session, `Failed to create bot: ${e.message}`);
        reconnect(session);
    }
}

function cleanupBot(session) {
    if (session.bot) {
        if (session.bot.afkInterval) clearInterval(session.bot.afkInterval);
        session.bot.removeAllListeners();
        session.bot = null;
    }
}

function reconnect(session) {
    if (!session.isBotRunning) return;

    log(session, 'Reconnecting in 5 seconds...');
    io.to(session.id).emit('status', 'Reconnecting...');

    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);

    session.reconnectTimeout = setTimeout(() => {
        if (session.isBotRunning) {
            createBot(session);
        }
    }, 5000);
}

function startAfkRoutine(session) {
    if (!session.bot) return;

    log(session, 'AFK routine started: Rotating, Jumping, and Swinging.');

    // Clear any existing interval
    if (session.bot.afkInterval) clearInterval(session.bot.afkInterval);

    session.bot.afkInterval = setInterval(() => {
        if (session.bot && session.bot.entity) {
            const bot = session.bot;
            // Randomize action
            const action = Math.random();

            // Always rotate a bit
            bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch + (Math.random() - 0.5), true);

            if (action > 0.8) {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 500);
            }

            if (action > 0.5) {
                bot.swingArm();
            }
        }
    }, 5000 + Math.random() * 5000);
}

// Socket.IO connection
io.on('connection', (socket) => {
    let currentSessionId = null;

    socket.on('join', (sessionId) => {
        if (!sessionId) return;

        currentSessionId = sessionId;
        socket.join(sessionId);

        const session = getSession(sessionId);

        // Send history and status
        session.logs.forEach(msg => socket.emit('log', msg));

        if (session.bot) {
            socket.emit('status', 'Connected');
            socket.emit('bot_info', { username: session.bot.username });
        } else if (session.isBotRunning) {
            socket.emit('status', 'Reconnecting...');
        } else {
            socket.emit('status', 'Stopped');
        }

        // Send current config
        socket.emit('config', session.botOptions);

        log(session, 'Web client joined session.');
    });

    socket.on('start_bot', (data) => {
        if (!currentSessionId) return;
        const session = getSession(currentSessionId);

        if (session.bot) {
            socket.emit('log', 'Bot is already running. Stop it first.');
            return;
        }

        session.botOptions.host = data.host || session.botOptions.host;
        session.botOptions.port = parseInt(data.port) || 25565;
        session.botOptions.username = data.username || session.botOptions.username;
        session.botOptions.version = data.version || false;

        session.isBotRunning = true;
        createBot(session);
    });

    socket.on('stop_bot', () => {
        if (!currentSessionId) return;
        const session = getSession(currentSessionId);

        session.isBotRunning = false;
        if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
        if (session.bot) {
            session.bot.quit();
            cleanupBot(session);
        }
        log(session, 'Bot stopped by user.');
        io.to(session.id).emit('status', 'Stopped');
    });

    socket.on('send_chat', (message) => {
        if (!currentSessionId) return;
        const session = getSession(currentSessionId);

        if (session.bot) {
            session.bot.chat(message);
            log(session, `[YOU]: ${message}`);
        } else {
            socket.emit('log', 'Bot is not connected.');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
