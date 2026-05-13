const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  // Buat Room
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    rooms.set(roomCode, {
      players: [{ id: socket.id, username, score: 0 }],
      currentDrawer: socket.id,
      currentWord: "Rumah",
      phase: "lobby",        // lobby, drawing, voting, results
      round: 1,
      maxRounds: 5,
      timer: null,
      timeLeft: 60
    });

    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  // Join Room
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) {
      return socket.emit('error', 'Room tidak ditemukan!');
    }

    const room = rooms.get(roomCode);
    room.players.push({ id: socket.id, username, score: 0 });
    
    socket.join(roomCode);
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

  // Chat
  socket.on('chat', (data) => {
    io.to(data.roomCode).emit('chat', data);
  });

  // Start Game (dari host)
  socket.on('startGame', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.phase = 'drawing';
    room.timeLeft = 60;
    
    io.to(roomCode).emit('gameStarted', {
      phase: 'drawing',
      drawer: room.currentDrawer,
      timeLeft: 60
    });

    startTimer(roomCode);
  });

  // Submit Rating / Vote
  socket.on('submitRating', ({ roomCode, rating }) => {  // rating 1-5
    const room = rooms.get(roomCode);
    if (!room) return;

    // Logic scoring nanti bisa dikembangkan
    io.to(roomCode).emit('ratingReceived', { rating });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// Timer Function
function startTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.timer) clearInterval(room.timer);

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.phase = 'voting';
      io.to(roomCode).emit('phaseChange', { phase: 'voting', timeLeft: 10 });
      
      // Auto next setelah 10 detik voting
      setTimeout(() => {
        nextRound(roomCode);
      }, 10000);
    }
  }, 1000);
}

function nextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Logic ganti drawer dan ronde baru (bisa dikembangkan)
  room.round++;
  room.phase = 'drawing';
  room.timeLeft = 60;

  io.to(roomCode).emit('nextRound', {
    round: room.round,
    phase: 'drawing',
    timeLeft: 60
  });

  startTimer(roomCode);
}

app.get('/', (req, res) => {
  res.send('🎨 Lomba Gambar Backend - Final Version ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Lomba Gambar berjalan di port ${PORT}`);
});