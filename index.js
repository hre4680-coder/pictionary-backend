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

// Helper untuk kategori kata (opsional untuk pengembangan lebih lanjut)
const wordCategories = {
  acak: ['Rumah', 'Mobil', 'Kucing', 'Matahari', 'Bunga', 'Gunung', 'Pantai', 'Sepeda', 'Buku', 'Pensil'],
  binatang: ['Kucing', 'Anjing', 'Gajah', 'Jerapah', 'Singa', 'Harimau', 'Kelinci', 'Burung', 'Ikan', 'Ular'],
  benda: ['Meja', 'Kursi', 'Pintu', 'Jendela', 'Ponsel', 'Laptop', 'Sendok', 'Piring', 'Tas', 'Topi'],
  profesi: ['Dokter', 'Guru', 'Polisi', 'Koki', 'Petani', 'Nelayan', 'Pilot', 'Arsitek', 'Pelukis', 'Penulis']
};

function getRandomWord(category) {
  const words = wordCategories[category] || wordCategories.acak;
  return words[Math.floor(Math.random() * words.length)];
}

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);

  // 1. Buat Room
  socket.on('createRoom', (username) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    rooms.set(roomCode, {
      players: [{ id: socket.id, username, score: 0 }],
      hostId: socket.id,
      currentDrawer: socket.id,
      currentWord: getRandomWord('acak'),
      phase: "lobby",        // lobby, drawing, voting
      round: 1,
      maxRounds: 3,
      roundDuration: 60,     // default
      timer: null,
      votingTimer: null,
      settings: { roundDuration: 60, maxRounds: 3, category: 'acak' }
    });

    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    io.to(roomCode).emit('playerList', rooms.get(roomCode).players);
    console.log(`Room ${roomCode} dibuat oleh ${username}`);
  });

  // 2. Join Room
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms.has(roomCode)) {
      return socket.emit('error', 'Room tidak ditemukan!');
    }

    const room = rooms.get(roomCode);
    // Cek apakah username sudah ada (optional)
    room.players.push({ id: socket.id, username, score: 0 });
    
    socket.join(roomCode);
    io.to(roomCode).emit('playerList', room.players);
    socket.emit('joinedRoom', roomCode);
    console.log(`${username} bergabung ke room ${roomCode}`);
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

  // 5. Start Game (dengan settings dari host)
  socket.on('startGame', (roomCode, settings) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;

    // Simpan settings
    if (settings) {
      room.settings = settings;
      room.roundDuration = settings.roundDuration;
      room.maxRounds = settings.maxRounds;
    } else {
      room.roundDuration = room.settings.roundDuration;
      room.maxRounds = room.settings.maxRounds;
    }
    
    room.timeLeft = room.roundDuration;
    room.phase = 'drawing';
    room.round = 1;
    // Pilih kata random sesuai kategori
    const category = room.settings.category || 'acak';
    room.currentWord = getRandomWord(category);
    
    // Kirim ke semua client
    io.to(roomCode).emit('gameStarted', { settings: room.settings });
    io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
    io.to(roomCode).emit('timerUpdate', room.timeLeft);
    
    startTimer(roomCode);
    console.log(`Game dimulai di room ${roomCode} dengan durasi ${room.roundDuration}dt, ${room.maxRounds} ronde`);
  });

  // 6. Submit Rating (voting) - sederhana
  socket.on('submitRating', ({ roomCode, rating }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    // Simpan rating (untuk pengembangan scoring)
    io.to(roomCode).emit('ratingReceived', { rating });
  });

  // 7. Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    // Hapus player dari semua room
    for (let [roomCode, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const leftPlayer = room.players[index];
        room.players.splice(index, 1);
        
        // Jika host keluar dan masih ada player, pindahkan host ke player pertama
        if (socket.id === room.hostId && room.players.length > 0) {
          room.hostId = room.players[0].id;
          io.to(roomCode).emit('chat', { username: 'Sistem', message: `${leftPlayer.username} keluar. Host baru: ${room.players[0].username}` });
        } else if (room.players.length === 0) {
          // Hapus room jika kosong
          if (room.timer) clearInterval(room.timer);
          if (room.votingTimer) clearTimeout(room.votingTimer);
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} dihapus karena kosong`);
          break;
        }
        
        io.to(roomCode).emit('playerList', room.players);
        io.to(roomCode).emit('chat', { username: 'Sistem', message: `${leftPlayer.username} meninggalkan ruangan` });
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
    if (!rooms.has(roomCode)) {
      clearInterval(room.timer);
      return;
    }
    
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      
      // Pindah ke fase voting
      room.phase = 'voting';
      io.to(roomCode).emit('phaseChange', { phase: 'voting' });
      io.to(roomCode).emit('timerUpdate', 10); // 10 detik voting
      io.to(roomCode).emit('chat', { username: 'Sistem', message: 'Waktu menggambar habis! Beri nilai untuk gambar ini (1-5) di chat atau fitur voting.' });
      
      // Timer voting 10 detik, lalu next round
      room.votingTimer = setTimeout(() => {
        nextRound(roomCode);
      }, 10000);
    }
  }, 1000);
}

function nextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Hapus voting timer jika masih ada
  if (room.votingTimer) clearTimeout(room.votingTimer);
  
  room.round++;
  
  // Cek apakah sudah mencapai maksimal ronde
  if (room.round > room.maxRounds) {
    // Game selesai
    io.to(roomCode).emit('gameEnded', { winners: room.players });
    io.to(roomCode).emit('chat', { username: 'Sistem', message: '🎉 Lomba selesai! Terima kasih telah bermain.' });
    // Reset room ke lobby? Atau hapus? Lebih baik jadi lobby lagi
    room.phase = 'lobby';
    room.round = 1;
    if (room.timer) clearInterval(room.timer);
    return;
  }
  
  // Mulai ronde baru - fase menggambar
  room.phase = 'drawing';
  room.timeLeft = room.roundDuration;
  
  // Pilih kata baru sesuai kategori
  const category = room.settings.category || 'acak';
  room.currentWord = getRandomWord(category);
  
  io.to(roomCode).emit('phaseChange', { phase: 'drawing' });
  io.to(roomCode).emit('timerUpdate', room.timeLeft);
  io.to(roomCode).emit('newRound', { round: room.round });
  io.to(roomCode).emit('chat', { username: 'Sistem', message: `🎨 Ronde ${room.round} dimulai! Kata: ${room.currentWord} (hanya visible untuk penggambar)` });
  
  startTimer(roomCode);
}

// ========== ROUTE ==========
app.get('/', (req, res) => {
  res.send('🎨 Lomba Gambar Backend - Siap Digunakan!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Lomba Gambar berjalan di port ${PORT}`);
});