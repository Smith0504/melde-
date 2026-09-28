const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Lädt alle Dateien direkt aus demselben Ordner
app.use(express.static(path.join(__dirname)));

const rooms = {};

function createDeck() {
    const suits = ['kreuz', 'pik', 'karo', 'herz'];
    const values = ['A', '10', 'K', 'D', 'B', '9', '8', '7'];
    const deck = [];
    
    for (let suit of suits) {
        for (let value of values) {
            let symbol = '♠️';
            if (suit === 'kreuz') symbol = '♣️';
            if (suit === 'karo') symbol = '♦️';
            if (suit === 'herz') symbol = '♥️';
            deck.push({ suit, value, symbol, isRed: (suit === 'herz' || suit === 'karo') });
        }
    }
    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomName, playerName }) => {
        if (!roomName || !playerName) return;

        socket.join(roomName);

        if (!rooms[roomName]) {
            rooms[roomName] = {
                name: roomName,
                players: [],
                gameStarted: false
            };
        }

        const room = rooms[roomName];

        if (room.players.length < 4 && !room.players.some(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName, hand: [] });
        }

        io.to(roomName).emit('roomUpdate', {
            roomName: room.name,
            players: room.players.map(p => p.name),
            playerCount: room.players.length
        });

        if (room.players.length === 4 && !room.gameStarted) {
            room.gameStarted = true;
            let deck = shuffle(createDeck());

            room.players.forEach((player, index) => {
                player.hand = deck.slice(index * 8, (index + 1) * 8);
                io.to(player.id).emit('gameStart', {
                    hand: player.hand,
                    players: room.players.map(p => p.name),
                    myIndex: index
                });
            });

            io.to(roomName).emit('message', 'Das Spiel hat begonnen! Karten perfekt gemischt.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
