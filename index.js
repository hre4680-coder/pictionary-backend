const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store rooms: roomCode -> room object
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  // 1. CREATE ROOM
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomCode, {
      players: [{ id: socket.id, username, score: 0 }],
      hostId: socket.id,
      phase: 'lobby',        // lobby, drawing, voting, winner
      round: 1,
      maxRounds: 3,
      roundDuration: 60,
      timer: null,
      timeLeft: 60,
      drawings: new Map(),    // playerId -> imageData (base64)
      votes: new Map(),       // voterId -> { targetId, rating }
      roundWinners: [],       // untuk menyimpan 3 besar sementara
      finalWinners: []        // akumulasi juara per ronde (opsional)
    });
    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  // 2. JOIN ROOM
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) {
      return socket.emit('error', 'Room tidak ditemukan!');
    }
    const room = rooms.get(roomCode);
    if (room.phase !== 'lobby') {
      return socket.emit('error', 'Game sudah berjalan, tidak bisa join!');
    }
    room.players.push({ id: socket.id, username, score: 0 });
    socket.join(roomCode);
    io.to(roomCode).emit('playerList', room.players);
    socket.emit('joinedRoom', roomCode);
  });

  // 3. START GAME (dengan settings)
  socket.on('startGame', ({ roomCode, settings }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;

    // Terapkan setting
    if (settings) {
      room.roundDuration = settings.duration || 60;
      room.maxRounds = settings.maxRounds || 3;
      // bisa tambahkan tema dll jika perlu
    }
    room.phase = 'drawing';
    room.round = 1;
    room.timeLeft = room.roundDuration;
    room.drawings.clear();
    room.votes.clear();
    room.roundWinners = [];

    io.to(roomCode).emit('gameStarted', {
      duration: room.roundDuration,
      maxRounds: room.maxRounds
    });
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    startDrawingTimer(roomCode);
  });

  // Timer untuk sesi menggambar
  function startDrawingTimer(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;
    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
      room.timeLeft--;
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.timer = null;
        io.to(roomCode).emit('timeoutDrawing');
        // Beri waktu 5 detik untuk mengirim gambar
        setTimeout(() => {
          const currentRoom = rooms.get(roomCode);
          if (currentRoom && currentRoom.phase === 'drawing') {
            startVotingPhase(roomCode);
          }
        }, 5000);
      }
    }, 1000);
  }

  // 4. Player mengirim gambar hasil karyanya
  socket.on('submitDrawing', ({ roomCode, imageData }) => {
    const room = rooms.get(roomCode);
    if (room && room.phase === 'drawing') {
      room.drawings.set(socket.id, imageData);
      // Cek apakah semua player sudah kirim
      if (room.drawings.size === room.players.length) {
        if (room.timer) clearInterval(room.timer);
        startVotingPhase(roomCode);
      }
    }
  });

  // 5. Mulai fase voting
  function startVotingPhase(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;
    room.phase = 'voting';
    room.votes.clear();
    // Siapkan array gambar (tanpa urutan tertentu)
    const images = Array.from(room.drawings.entries()).map(([playerId, imgData]) => {
      const player = room.players.find(p => p.id === playerId);
      return { playerId, username: player.username, imageData: imgData };
    });
    io.to(roomCode).emit('votingStart', { images });
    // Voting timer 30 detik, jika belum selesai akan diproses paksa
    if (room.votingTimer) clearTimeout(room.votingTimer);
    room.votingTimer = setTimeout(() => {
      const finalRoom = rooms.get(roomCode);
      if (finalRoom && finalRoom.phase === 'voting') {
        calculateWinners(roomCode);
      }
    }, 30000);
  }

  // 6. Player mengirim vote untuk sebuah gambar
  socket.on('submitVote', ({ roomCode, targetPlayerId, rating }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;
    // Simpan vote (hanya satu kali per voter)
    room.votes.set(socket.id, { targetId: targetPlayerId, rating });
    // Jika semua sudah vote, langsung hitung
    if (room.votes.size === room.players.length) {
      clearTimeout(room.votingTimer);
      calculateWinners(roomCode);
    }
  });

  // 7. Menghitung juara 1,2,3 berdasarkan rating
  function calculateWinners(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;

    // Akumulasi rating per playerId
    const ratingSum = new Map();   // playerId -> total rating
    const ratingCount = new Map(); // playerId -> jumlah voter
    for (let vote of room.votes.values()) {
      const tid = vote.targetId;
      ratingSum.set(tid, (ratingSum.get(tid) || 0) + vote.rating);
      ratingCount.set(tid, (ratingCount.get(tid) || 0) + 1);
    }

    // Hitung rata-rata untuk setiap player yang digambar (drawings)
    const averages = [];
    for (let [playerId, total] of ratingSum.entries()) {
      const avg = total / ratingCount.get(playerId);
      const player = room.players.find(p => p.id === playerId);
      if (player) {
        averages.push({ playerId, username: player.username, averageRating: avg, imageData: room.drawings.get(playerId) });
      }
    }
    // Urutkan dari rata-rata tertinggi
    averages.sort((a, b) => b.averageRating - a.averageRating);
    const winners = averages.slice(0, 3); // juara 1,2,3
    // Tambahkan skor ke pemain (juara 1 dapet 100, juara 2 dapet 50, juara 3 dapet 25)
    if (winners[0]) {
      const winnerPlayer = room.players.find(p => p.id === winners[0].playerId);
      if (winnerPlayer) winnerPlayer.score += 100;
    }
    if (winners[1]) {
      const secondPlayer = room.players.find(p => p.id === winners[1].playerId);
      if (secondPlayer) secondPlayer.score += 50;
    }
    if (winners[2]) {
      const thirdPlayer = room.players.find(p => p.id === winners[2].playerId);
      if (thirdPlayer) thirdPlayer.score += 25;
    }

    room.roundWinners = winners;
    room.phase = 'winner';
    io.to(roomCode).emit('winnerResult', { winners });
  }

  // 8. Lanjut ke ronde berikutnya (dari client setelah lihat hasil)
  socket.on('continueToNextRound', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.round < room.maxRounds) {
      room.round++;
      room.phase = 'drawing';
      room.timeLeft = room.roundDuration;
      room.drawings.clear();
      room.votes.clear();
      room.roundWinners = [];
      if (room.timer) clearInterval(room.timer);
      startDrawingTimer(roomCode);
      io.to(roomCode).emit('nextRound', { round: room.round, maxRounds: room.maxRounds });
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
      // Bersihkan canvas di semua client
      io.to(roomCode).emit('clearAllCanvas');
    } else {
      // Game selesai, kirim pemenang keseluruhan berdasarkan akumulasi skor
      const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
      const finalWinner = sortedPlayers[0];
      io.to(roomCode).emit('gameEnded', { winner: finalWinner, allScores: sortedPlayers });
      rooms.delete(roomCode);
    }
  });

  // 9. Chat
  socket.on('chat', (data) => {
    io.to(data.roomCode).emit('chat', data);
  });

  // 10. Disconnect
  socket.on('disconnect', () => {
    console.log(`❌ Player disconnected: ${socket.id}`);
    for (let [roomCode, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        io.to(roomCode).emit('playerList', room.players);
        if (room.players.length === 0) {
          if (room.timer) clearInterval(room.timer);
          if (room.votingTimer) clearTimeout(room.votingTimer);
          rooms.delete(roomCode);
        }
        break;
      }
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('🎨 Lomba Gambar Server is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});