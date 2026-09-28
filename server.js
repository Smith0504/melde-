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
        publicRooms[r] = {
            playerCount: rooms[r].players.length
        };
    }
    io.emit('roomListUpdate', publicRooms);
}

io.on('connection', (socket) => {
    // Sende aktuelle Raumliste beim Verbinden
    socket.on('getRooms', () => {
        const publicRooms = {};
        for (let r in rooms) {
            publicRooms[r] = {
                playerCount: rooms[r].players.length
            };
        }
        socket.emit('roomListUpdate', publicRooms);
    });

    socket.on('joinRoom', ({ roomName, player }) => {
        if (!roomName || !player) return;

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
            room.players.push({ id: socket.id, ...player, hand: [] });
        }

        socket.emit('joinedRoomSuccess', roomName);
        broadcastRoomList();

        io.to(roomName).emit('roomUpdate', {
            roomName: room.name,
            players: room.players.map(p => p.name),
            playerCount: room.players.length
        });
    });

    socket.on('disconnect', () => {
        for (let rName in rooms) {
            rooms[rName].players = rooms[rName].players.filter(p => p.id !== socket.id);
            if (rooms[rName].players.length === 0) {
                delete rooms[rName];
            }
        }
        broadcastRoomList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
