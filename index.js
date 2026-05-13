const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",        // Nanti kita ganti dengan domain Vercel
    methods: ["GET", "POST"]
  }
});

// Simpan data room (sementara di memory)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Player terkoneksi:', socket.id);

  // Buat Room Baru
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    rooms.set(roomCode, {
      players: [{ id: socket.id, username }],
      scores: { [username]: 0 },
      currentDrawer: null,
      word: null
    });

    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  // Join Room
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) {
      socket.emit('error', 'Room tidak ditemukan!');
      return;
    }

    socket.join(roomCode);
    const room = rooms.get(roomCode);
    room.players.push({ id: socket.id, username });
    room.scores[username] = 0;

    io.to(roomCode).emit('playerList', room.players);
    socket.emit('joinedRoom', roomCode);
  });

  // Drawing
  socket.on('drawing', (data) => {
    socket.to(data.roomCode).emit('drawing', data);
  });

  socket.on('clearCanvas', (roomCode) => {
    socket.to(roomCode).emit('clearCanvas');
  });

  // Chat & Jawaban
  socket.on('chat', (data) => {
    io.to(data.roomCode).emit('chat', data);
  });

  socket.on('disconnect', () => {
    console.log('Player keluar:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server berjalan di port ${PORT}`);
});