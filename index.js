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

  // 1. Buat Room
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    rooms.set(roomCode, {
      players: [{ id: socket.id, username, score: 0 }],
      currentDrawer: socket.id,
      currentWord: "Rumah",
      phase: "lobby",        // lobby, drawing, voting
      round: 1,
      maxRounds: 3,          // misal 3 ronde
      timer: null,
      timeLeft: 60,
      hostId: socket.id
    });

    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  // 2. Join Room
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

  // 3. Drawing
  socket.on('drawing', (data) => {
    socket.to(data.roomCode).emit('drawing', data);
  });

  socket.on('clearCanvas', (roomCode) => {
    socket.to(roomCode).emit('clearCanvas');
  });

  // 4. Chat
  socket.on('chat', (data) => {
    io.to(data.roomCode).emit('chat', data);
  });

  // 5. Start Game (hanya host)
  socket.on('startGame', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    
    if (room.phase !== 'lobby') return;
    
    room.phase = 'drawing';
    room.timeLeft = 60;
    room.round = 1;
    
    // Beri tahu semua client bahwa game dimulai, fase menggambar
    io.to(roomCode).emit('gameStarted');
    io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    
    startTimer(roomCode);
  });

  // 6. Submit Rating (optional, bisa dikembangkan)
  socket.on('submitRating', ({ roomCode, rating }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit('ratingReceived', { rating });
  });

  // 7. Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    // Hapus player dari room (opsional)
    for (let [roomCode, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          if (room.timer) clearInterval(room.timer);
          rooms.delete(roomCode);
        } else {
          io.to(roomCode).emit('playerList', room.players);
        }
        break;
      }
    }
  });
});

// ========== FUNGSI TIMER ==========
function startTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.phase !== 'drawing') return;

  if (room.timer) clearInterval(room.timer);

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      
      // Pindah ke fase voting
      room.phase = 'voting';
      io.to(roomCode).emit('phaseChange', { phase: 'voting' });
      io.to(roomCode).emit('timerUpdate', 10); // 10 detik voting
      
      // Set timer voting 10 detik
      const votingTimer = setTimeout(() => {
        // Setelah voting, lanjut ke ronde berikutnya atau selesai
        nextRound(roomCode);
      }, 10000);
      
      // Simpan timer voting agar bisa dibatalkan jika perlu
      room.votingTimeout = votingTimer;
    }
  }, 1000);
}

function nextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Hapus voting timeout jika masih ada
  if (room.votingTimeout) clearTimeout(room.votingTimeout);
  
  room.round++;
  
  // Cek apakah sudah mencapai maksimal ronde
  if (room.round > room.maxRounds) {
    // Game selesai
    io.to(roomCode).emit('gameEnded', { winners: room.players });
    if (room.timer) clearInterval(room.timer);
    rooms.delete(roomCode);
    return;
  }
  
  // Mulai ronde baru - fase menggambar
  room.phase = 'drawing';
  room.timeLeft = 60;
  
  // (Opsional) Ganti kata atau drawer. Untuk sederhana, tetap pakai kata yang sama
  // room.currentWord = getRandomWord();
  
  io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
  io.to(roomCode).emit('timerUpdate', room.timeLeft);
  io.to(roomCode).emit('newRound', { round: room.round });
  
  startTimer(roomCode);
}

// ========== START SERVER ==========
app.get('/', (req, res) => {
  res.send('🎨 Lomba Gambar Backend - Final Version ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Lomba Gambar berjalan di port ${PORT}`);
});