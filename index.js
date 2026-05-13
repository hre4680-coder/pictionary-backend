const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  // Create Room
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomCode, {
      players: [{ id: socket.id, username, score: 0 }],
      hostId: socket.id,
      phase: 'lobby',
      round: 1,
      maxRounds: 3,
      roundDuration: 60,
      timer: null,
      timeLeft: 60,
      currentDrawer: socket.id,
      currentWord: "Rumah",
      ratings: [],         // { playerId, rating, comment, imageData }
      winnerImage: null,
      winnerUsername: null
    });
    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  // Join Room
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) return socket.emit('error', 'Room tidak ada');
    const room = rooms.get(roomCode);
    if (room.phase !== 'lobby') return socket.emit('error', 'Game sudah berjalan');
    room.players.push({ id: socket.id, username, score: 0 });
    socket.join(roomCode);
    io.to(roomCode).emit('playerList', room.players);
    socket.emit('joinedRoom', roomCode);
  });

  // Start Game dengan settings
  socket.on('startGame', (roomCode, settings) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;
    if (settings) {
      room.roundDuration = settings.roundDuration || 60;
      room.maxRounds = settings.maxRounds || 3;
    }
    room.timeLeft = room.roundDuration;
    room.phase = 'drawing';
    room.round = 1;
    startTimer(roomCode);
    io.to(roomCode).emit('gameStarted', { settings: { roundDuration: room.roundDuration, maxRounds: room.maxRounds } });
    io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
  });

  // Drawing
  socket.on('drawing', (data) => socket.to(data.roomCode).emit('drawing', data));
  socket.on('clearCanvas', (roomCode) => socket.to(roomCode).emit('clearCanvas'));
  socket.on('chat', (data) => io.to(data.roomCode).emit('chat', data));

  // Submit Rating
  socket.on('submitRating', ({ roomCode, rating, comment, imageData }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;
    // Cek apakah player sudah rating
    const already = room.ratings.find(r => r.playerId === socket.id);
    if (already) return;
    room.ratings.push({ playerId: socket.id, rating, comment, imageData });
    // Jika semua player sudah rating, proses hasil
    if (room.ratings.length === room.players.length) {
      processWinner(roomCode);
    }
  });

  // Lanjut ke ronde berikutnya (dari tombol setelah lihat juara)
  socket.on('continueToNextRound', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.round < room.maxRounds) {
      room.round++;
      room.phase = 'drawing';
      room.timeLeft = room.roundDuration;
      room.ratings = [];
      room.winnerImage = null;
      room.winnerUsername = null;
      // Hapus canvas semua pemain
      io.to(roomCode).emit('clearCanvas');
      io.to(roomCode).emit('nextRound', room.round);
      io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
      startTimer(roomCode);
    } else {
      // Game selesai, cari pemenang overall berdasarkan score (sederhana)
      let best = room.players.reduce((a,b) => (a.score > b.score) ? a : b, room.players[0]);
      io.to(roomCode).emit('gameEnded', best);
      rooms.delete(roomCode);
    }
  });

  function startTimer(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;
    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
      room.timeLeft--;
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.phase = 'voting';
        io.to(roomCode).emit('phaseChange', { phase: 'voting', showRatingModal: true });
        io.to(roomCode).emit('timeoutNotification', '⏰ Waktu menggambar habis! Silakan beri rating.');
        // Kirim reminder rating ke semua player
        setTimeout(() => {
          // Jika belum semua rating dalam 15 detik, proses paksa
          const checkRoom = rooms.get(roomCode);
          if (checkRoom && checkRoom.phase === 'voting') {
            processWinner(roomCode);
          }
        }, 15000);
      }
    }, 1000);
  }

  function processWinner(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;
    if (room.timer) clearInterval(room.timer);
    // Hitung rata-rata rating per player (dari gambar yang dikirim)
    let ratingMap = new Map(); // playerId -> total rating, count, comments, imageData
    room.ratings.forEach(r => {
      // Kita ambil imageData dari rating yang dikirim (gambar pemenang adalah gambar dari yang dinilai? agak rumit.
      // Sederhananya: pemenang adalah player yang menerima rating tertinggi.
      // Tapi kita tidak tahu rating untuk siapa. Untuk demo, kita asumsikan setiap rating adalah untuk si penggambar (currentDrawer).
      // Lebih simple: kita kumpulkan rating untuk currentDrawer.
    });
    // Alternatif: pemenang adalah player dengan rating tertinggi dari semua rating yang masuk (rating diberikan ke gambar, berarti gambar dari currentDrawer)
    const drawerId = room.currentDrawer;
    const drawerRatings = room.ratings.filter(r => r.playerId !== drawerId); // rating dari orang lain
    let totalStars = 0;
    let comments = [];
    let winnerImage = null;
    drawerRatings.forEach(r => {
      totalStars += r.rating;
      if (r.comment) comments.push(r.comment);
      if (!winnerImage && r.imageData) winnerImage = r.imageData;
    });
    const avgStar = drawerRatings.length ? (totalStars / drawerRatings.length).toFixed(1) : 0;
    const drawerPlayer = room.players.find(p => p.id === drawerId);
    if (drawerPlayer) {
      drawerPlayer.score += Math.floor(avgStar * 10);
    }
    room.winnerUsername = drawerPlayer ? drawerPlayer.username : 'Unknown';
    room.winnerImage = winnerImage || '';
    io.to(roomCode).emit('ratingResult', {
      winnerUsername: room.winnerUsername,
      winnerImageData: room.winnerImage,
      averageStar: avgStar,
      comments: comments
    });
    // Jangan lanjut otomatis, tunggu continueToNextRound dari client
  }

  socket.on('disconnect', () => {
    // Hapus player dari room
    for (let [roomCode, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomCode).emit('playerList', room.players);
        if (room.players.length === 0) {
          if (room.timer) clearInterval(room.timer);
          rooms.delete(roomCode);
        }
        break;
      }
    }
  });
});

app.get('/', (req, res) => res.send('🎨 Server Lomba Gambar dengan Rating'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server jalan di port ${PORT}`));