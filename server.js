const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const rooms = {};

function broadcastRoomList() {
    const publicRooms = {};
    for (let r in rooms) {
        if (!rooms[r].gameStarted) {
            publicRooms[r] = {
                playerCount: rooms[r].players.length
            };
        }
    }
    io.emit('roomListUpdate', publicRooms);
}

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['7', '8', '9', '10', 'B', 'D', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ suit, value });
        }
    }
    // Mischen
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    socket.on('getRooms', () => {
        const publicRooms = {};
        for (let r in rooms) {
            if (!rooms[r].gameStarted) {
                publicRooms[r] = {
                    playerCount: rooms[r].players.length
                };
            }
        }
        socket.emit('roomListUpdate', publicRooms);
    });

    socket.on('joinRoom', ({ roomName, player }) => {
        if (!roomName || !player) return;

        if (rooms[roomName] && rooms[roomName].gameStarted) {
            return; 
        }

        socket.join(roomName);

        if (!rooms[roomName]) {
            rooms[roomName] = {
                name: roomName,
                players: [],
                gameStarted: false,
                dealerIndex: 0
            };
        }

        const room = rooms[roomName];

        if (room.players.length < 4 && !room.players.some(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, ...player, hand: [] });
        }

        socket.emit('joinedRoomSuccess', roomName);
        broadcastRoomList();

        io.to(roomName).emit('roomUpdate', {
            roomName: room.name,
            players: room.players.map(p => ({ id: p.id, name: p.name, stadt: p.stadt })),
            playerCount: room.players.length
        });

        // WENN 4 SPIELER DA SIND -> VERTEILER BESTIMMEN & AUSWAHL STARTEN
        if (room.players.length === 4 && !room.gameStarted) {
            room.dealerIndex = 0; // Erster Spieler ist Verteiler
            const choosingIndex = (room.dealerIndex + 3) % 4; // Spieler rechts vom Verteiler
            const choosingPlayer = room.players[choosingIndex];
            const dealerPlayer = room.players[room.dealerIndex];

            io.to(choosingPlayer.id).emit('promptDealChoice', {
                dealerName: dealerPlayer.name
            });

            room.players.forEach(p => {
                if (p.id !== choosingPlayer.id) {
                    io.to(p.id).emit('waitingForDealChoice', {
                        choosingName: choosingPlayer.name,
                        dealerName: dealerPlayer.name
                    });
                }
            });
        }
    });

    // Wenn der Spieler die Verteilerart ausgewählt hat
    socket.on('chooseDealMethod', ({ roomName, method }) => {
        const room = rooms[roomName];
        if (!room) return;

        room.gameStarted = true;
        broadcastRoomList();

        const deck = createDeck();
        const cardsPerPlayer = 6;

        room.players.forEach(p => {
            p.hand = deck.splice(0, cardsPerPlayer);
            io.to(p.id).emit('gameStarted', { hand: p.hand, method: method });
        });
    });

    socket.on('disconnect', () => {
        for (let rName in rooms) {
            rooms[rName].players = rooms[rName].players.filter(p => p.id !== socket.id);
            if (rooms[rName].players.length === 0) {
                delete rooms[rName];
            } else if (!rooms[rName].gameStarted) {
                io.to(rName).emit('roomUpdate', {
                    roomName: rooms[rName].name,
                    players: rooms[rName].players.map(p => ({ id: p.id, name: p.name, stadt: p.stadt })),
                    playerCount: rooms[rName].players.length
                });
            }
        }
        broadcastRoomList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
