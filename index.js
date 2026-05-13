const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`✅ ${socket.id} connected`);

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
      drawings: new Map(), // playerId -> imageData
      votes: new Map(),    // voterId -> { targetId, rating }
      roundWinner: null
    });
    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
  });

  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) return socket.emit('error', 'Room tidak ditemukan');
    const room = rooms.get(roomCode);
    if (room.phase !== 'lobby') return socket.emit('error', 'Game sudah berjalan');
    room.players.push({ id: socket.id, username, score: 0 });
    socket.join(roomCode);
    io.to(roomCode).emit('playerList', room.players);
    socket.emit('joinedRoom', roomCode);
  });

  socket.on('startGame', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;
    room.phase = 'drawing';
    room.timeLeft = room.roundDuration;
    startTimer(roomCode);
    io.to(roomCode).emit('gameStarted', { duration: room.roundDuration });
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
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
        room.timer = null;
        io.to(roomCode).emit('timeoutDrawing');
        // Tunggu semua player kirim gambar (maks 5 detik)
        setTimeout(() => {
          const updatedRoom = rooms.get(roomCode);
          if (updatedRoom && updatedRoom.phase === 'drawing') {
            startVoting(roomCode);
          }
        }, 5000);
      }
    }, 1000);
  }

  socket.on('submitDrawing', ({ roomCode, imageData }) => {
    const room = rooms.get(roomCode);
    if (room && room.phase === 'drawing') {
      room.drawings.set(socket.id, imageData);
      // Cek jika semua player sudah kirim gambar
      if (room.drawings.size === room.players.length) {
        startVoting(roomCode);
      }
    }
  });

  function startVoting(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;
    room.phase = 'voting';
    if (room.timer) clearInterval(room.timer);
    // Kirim daftar gambar ke semua player untuk divoting
    const images = Array.from(room.drawings.entries()).map(([playerId, imageData]) => {
      const player = room.players.find(p => p.id === playerId);
      return { playerId, username: player.username, imageData };
    });
    io.to(roomCode).emit('votingPhase', { images });
    // Timer voting 20 detik, lalu paksa hitung hasil
    room.votingTimer = setTimeout(() => {
      const finalRoom = rooms.get(roomCode);
      if (finalRoom && finalRoom.phase === 'voting') {
        calculateWinner(roomCode);
      }
    }, 20000);
  }

  socket.on('submitVote', ({ roomCode, targetPlayerId, rating }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;
    room.votes.set(socket.id, { targetId: targetPlayerId, rating });
    // Jika semua sudah voting, hitung pemenang
    if (room.votes.size === room.players.length) {
      clearTimeout(room.votingTimer);
      calculateWinner(roomCode);
    }
  });

  function calculateWinner(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;
    // Hitung total rating per player
    const ratingSum = new Map();
    const ratingCount = new Map();
    for (let vote of room.votes.values()) {
      const tid = vote.targetId;
      ratingSum.set(tid, (ratingSum.get(tid) || 0) + vote.rating);
      ratingCount.set(tid, (ratingCount.get(tid) || 0) + 1);
    }
    let winnerId = null;
    let highestAvg = -1;
    for (let [pid, total] of ratingSum.entries()) {
      const avg = total / ratingCount.get(pid);
      if (avg > highestAvg) {
        highestAvg = avg;
        winnerId = pid;
      }
    }
    const winnerPlayer = room.players.find(p => p.id === winnerId);
    if (winnerPlayer) {
      winnerPlayer.score += Math.floor(highestAvg * 10);
      room.roundWinner = { username: winnerPlayer.username, imageData: room.drawings.get(winnerId), averageRating: highestAvg.toFixed(1) };
    }
    io.to(roomCode).emit('winnerResult', room.roundWinner);
    room.phase = 'winner';
  }

  socket.on('continueGame', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.round < room.maxRounds) {
      room.round++;
      room.phase = 'drawing';
      room.timeLeft = room.roundDuration;
      room.drawings.clear();
      room.votes.clear();
      room.roundWinner = null;
      if (room.timer) clearInterval(room.timer);
      startTimer(roomCode);
      io.to(roomCode).emit('nextRound', room.round);
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
    } else {
      // Game selesai, cari skor tertinggi
      let champion = room.players.reduce((a,b) => (a.score > b.score) ? a : b, room.players[0]);
      io.to(roomCode).emit('gameEnded', champion);
      rooms.delete(roomCode);
    }
  });

  socket.on('chat', (data) => io.to(data.roomCode).emit('chat', data));
  socket.on('disconnect', () => {
    for (let [rc, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(rc).emit('playerList', room.players);
        if (room.players.length === 0) {
          if (room.timer) clearInterval(room.timer);
          rooms.delete(rc);
        }
        break;
      }
    }
  });
});

app.get('/', (req, res) => res.send('🎨 Server Lomba Gambar (per-player canvas)'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));