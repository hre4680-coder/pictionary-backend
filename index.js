const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://pictioniry.netlify.app", // GANTI dengan URL Netlify kamu
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "*"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Simpan semua room
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  // ================== CREATE ROOM ==================
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    rooms.set(roomCode, {
      players: [{ id: socket.id, username }],
      scores: { [username]: 0 },
      currentDrawer: socket.id,
      word: null
    });

    socket.join(roomCode);
    console.log(`Room dibuat: ${roomCode} oleh ${username}`);

    socket.emit('roomCreated', roomCode);
  });

  // ================== JOIN ROOM ==================
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) {
      socket.emit('error', 'Room tidak ditemukan!');
      return;
    }

    socket.join(roomCode);
    const room = rooms.get(roomCode);
    
    room.players.push({ id: socket.id, username });
    room.scores[username] = 0;

    console.log(`${username} bergabung ke room ${roomCode}`);

    io.to(roomCode).emit('playerList', room.players); // update daftar player
    socket.emit('joinedRoom', roomCode);
  });

  // ================== DRAWING ==================
  socket.on('drawing', (data) => {
    socket.to(data.roomCode).emit('drawing', data);
  });

  // ================== CLEAR CANVAS ==================
  socket.on('clearCanvas', (roomCode) => {
    socket.to(roomCode).emit('clearCanvas');
  });

  // ================== CHAT ==================
  socket.on('chat', (data) => {
    io.to(data.roomCode).emit('chat', {
      username: data.username,
      message: data.message
    });
  });

  // ================== DISCONNECT ==================
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    // Bisa ditambah logic remove player dari room nanti
  });
});

// Health check
app.get('/', (req, res) => {
  res.send('Pictionary Backend is running ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});