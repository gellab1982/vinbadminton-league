const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// --- 1. DỮ LIỆU IN-MEMORY (CÓ THỂ NÂNG CẤP LÊN SQLITE/MONGODB) ---
const MAX_CONCURRENT_USERS = 50;
let activeConnections = 0;

let users = [
  { id: '1', username: 'admin', password: 'admin123', role: 'SUPER_ADMIN', name: 'Super Admin' },
  { id: '2', username: 'manager', password: 'manager123', role: 'MANAGER', name: 'Quản Lý Giải' }
];

let tournaments = [
  {
    id: 'tour-1',
    name: 'Giải Cầu Lông Mở Rộng 2026',
    slug: 'giai-mo-rong-2026',
    status: 'ACTIVE',
    matches: [
      { id: 'm1', teamA: 'Nguyễn Văn A / Trần Văn B', teamB: 'Lê Văn C / Phạm Văn D', scoreA: [21, 19, 21], scoreB: [18, 21, 15], status: 'FINISHED' },
      { id: 'm2', teamA: 'Hoàng Văn E / Vũ Văn F', teamB: 'Đặng Văn G / Bùi Văn H', scoreA: [15, 0], scoreB: [21, 0], status: 'PLAYING' }
    ]
  }
];

// --- 2. MIDDLEWARE ĐIỀU HƯỚNG & GIỚI HẠN 50 USERS ---
io.use((socket, next) => {
  if (activeConnections >= MAX_CONCURRENT_USERS) {
    const err = new Error('Hệ thống đang đạt giới hạn tối đa 50 người truy cập cùng lúc. Vui lòng thử lại sau!');
    err.data = { code: 'FULL' };
    return next(err);
  }
  next();
});

io.on('connection', (socket) => {
  activeConnections++;
  io.emit('userCountUpdate', activeConnections);

  socket.on('disconnect', () => {
    activeConnections = Math.max(0, activeConnections - 1);
    io.emit('userCountUpdate', activeConnections);
  });
});

// --- 3. REST API ENDPOINTS ---
// API Đăng nhập
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Tài khoản hoặc mật khẩu không đúng' });
  res.json({ id: user.id, username: user.username, role: user.role, name: user.name });
});

// Lấy danh sách giải đấu
app.get('/api/tournaments', (req, res) => {
  res.json(tournaments);
});

// Tạo giải đấu mới (Chỉ Admin)
app.post('/api/tournaments', (req, res) => {
  const { name, role } = req.body;
  if (role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Chỉ Admin mới có quyền tạo giải đấu' });
  
  const newTour = {
    id: 'tour-' + Date.now(),
    name,
    slug: name.toLowerCase().replace(/ /g, '-'),
    status: 'ACTIVE',
    matches: []
  };
  tournaments.push(newTour);
  io.emit('dataUpdated');
  res.json(newTour);
});

// Thêm cặp đấu mới vào giải đấu
app.post('/api/tournaments/:id/matches', (req, res) => {
  const { id } = req.params;
  const { teamA, teamB, role } = req.body;
  if (!['SUPER_ADMIN', 'MANAGER'].includes(role)) return res.status(403).json({ error: 'Không có quyền thực hiện' });

  const tour = tournaments.find(t => t.id === id);
  if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu' });

  const newMatch = {
    id: 'm-' + Date.now(),
    teamA,
    teamB,
    scoreA: [0, 0, 0],
    scoreB: [0, 0, 0],
    status: 'SCHEDULED'
  };
  tour.matches.push(newMatch);
  io.emit('dataUpdated');
  res.json(newMatch);
});

// Chỉnh sửa tỉ số / thông tin trận đấu
app.put('/api/tournaments/:tourId/matches/:matchId', (req, res) => {
  const { tourId, matchId } = req.params;
  const { teamA, teamB, scoreA, scoreB, status, role } = req.body;
  if (!['SUPER_ADMIN', 'MANAGER'].includes(role)) return res.status(403).json({ error: 'Không có quyền thực hiện' });

  const tour = tournaments.find(t => t.id === tourId);
  if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu' });

  const match = tour.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Không tìm thấy trận đấu' });

  if (teamA) match.teamA = teamA;
  if (teamB) match.teamB = teamB;
  if (scoreA) match.scoreA = scoreA;
  if (scoreB) match.scoreB = scoreB;
  if (status) match.status = status;

  io.emit('dataUpdated');
  res.json(match);
});

// Tạo tài khoản Manager mới (Chỉ Super Admin)
app.post('/api/users/manager', (req, res) => {
  const { username, password, name, role } = req.body;
  if (role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Chỉ Super Admin mới có quyền tạo Manager' });

  const newUser = {
    id: 'u-' + Date.now(),
    username,
    password,
    role: 'MANAGER',
    name
  };
  users.push(newUser);
  res.json({ message: 'Tạo tài khoản Quản lý thành công', user: newUser });
});

// --- 4. TRANG FRONTEND CLIENT (SINGLE PAGE APPLICATION) ---
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VinBadminton League System</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="/socket.io/socket.io.js"></script>
</head>
<body class="bg-gray-100 font-sans min-h-screen">
  <!-- Header -->
  <header class="bg-emerald-700 text-white p-4 shadow-lg flex justify-between items-center">
    <div>
      <h1 class="text-2xl font-bold">🏸 VinBadminton League</h1>
      <p class="text-xs text-emerald-200">Hệ thống quản lý & theo dõi tỉ số cầu lông thời gian thực</p>
    </div>
    <div class="flex items-center gap-4">
      <span id="userCountBadge" class="bg-emerald-900 text-xs px-3 py-1 rounded-full border border-emerald-500">
        🟢 Online: <b id="onlineCount">0</b>/50
      </span>
      <div id="authSection">
        <button onclick="openLoginModal()" class="bg-white text-emerald-800 px-3 py-1 rounded font-semibold text-sm hover:bg-emerald-50">Đăng Nhập</button>
      </div>
    </div>
  </header>

  <!-- Main Container -->
  <div class="max-w-6xl mx-auto p-4 md:p-6">
    <!-- Cửa sổ các giải đấu -->
    <div class="flex border-b border-gray-300 mb-6 overflow-x-auto" id="tournamentTabs"></div>

    <!-- Admin & Manager Actions -->
    <div id="adminPanel" class="hidden mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
      <h3 class="font-bold text-yellow-800 mb-2">⚙️ Bảng Điều Hành Management</h3>
      <div class="flex flex-wrap gap-2" id="adminButtons"></div>
    </div>

    <!-- Nội dung giải đấu -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Lịch thi đấu & Tỉ số (2 Cols) -->
      <div class="lg:col-span-2 space-y-4">
        <h2 class="text-xl font-bold text-gray-800 flex justify-between items-center">
          <span>⚔️ Lịch Thi Đấu & Kết Quả</span>
        </h2>
        <div id="matchesList" class="space-y-3"></div>
      </div>

      <!-- Bảng Xếp Hạng Tổng (1 Col) -->
      <div>
        <h2 class="text-xl font-bold text-gray-800 mb-4">🏆 Bảng Xếp Hạng</h2>
        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="w-full text-sm text-left text-gray-600">
            <thead class="text-xs text-gray-700 uppercase bg-gray-50 border-b">
              <tr>
                <th class="px-3 py-2">Đội / Cặp Đấu</th>
                <th class="px-2 py-2 text-center">T</th>
                <th class="px-2 py-2 text-center">B</th>
                <th class="px-2 py-2 text-center">ĐIỂM</th>
              </tr>
            </thead>
            <tbody id="standingsBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal Đăng nhập -->
  <div id="loginModal" class="fixed inset-0 bg-black/50 hidden flex items-center justify-center p-4">
    <div class="bg-white rounded-lg p-6 w-full max-w-md">
      <h3 class="text-lg font-bold mb-4">Đăng nhập Quản trị</h3>
      <input id="loginUser" type="text" placeholder="Tên đăng nhập" class="w-full border p-2 mb-3 rounded">
      <input id="loginPass" type="password" placeholder="Mật khẩu" class="w-full border p-2 mb-4 rounded">
      <div class="flex justify-end gap-2">
        <button onclick="closeLoginModal()" class="px-4 py-2 text-gray-500">Hủy</button>
        <button onclick="handleLogin()" class="px-4 py-2 bg-emerald-600 text-white rounded">Đăng nhập</button>
      </div>
    </div>
  </div>

  <script>
    const socket = io();
    let currentAuth = null;
    let selectedTourId = null;
    let tournamentsData = [];

    socket.on('userCountUpdate', (count) => {
      document.getElementById('onlineCount').innerText = count;
    });

    socket.on('connect_error', (err) => {
      if (err.data && err.data.code === 'FULL') {
        alert(err.message);
      }
    });

    socket.on('dataUpdated', () => {
      fetchTournaments();
    });

    async function fetchTournaments() {
      const res = await fetch('/api/tournaments');
      tournamentsData = await res.json();
      if (!selectedTourId && tournamentsData.length > 0) {
        selectedTourId = tournamentsData[0].id;
      }
      renderUI();
    }

    function renderUI() {
      // Render Tabs
      const tabs = document.getElementById('tournamentTabs');
      tabs.innerHTML = tournamentsData.map(t => \`
        <button onclick="switchTour('\${t.id}')" class="px-4 py-2 font-medium text-sm border-b-2 \${t.id === selectedTourId ? 'border-emerald-600 text-emerald-600 font-bold bg-white' : 'border-transparent text-gray-500 hover:text-gray-700'}\">
          \${t.name}
        </button>
      \`).join('');

      // Render Admin Buttons
      const adminPanel = document.getElementById('adminPanel');
      const adminButtons = document.getElementById('adminButtons');
      if (currentAuth) {
        adminPanel.classList.remove('hidden');
        let btns = \`<button onclick="addMatchPrompt()" class="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded">+ Thêm Cặp Đấu</button>\`;
        if (currentAuth.role === 'SUPER_ADMIN') {
          btns += \`
            <button onclick="addTournamentPrompt()" class="bg-blue-600 text-white text-xs px-3 py-1.5 rounded">+ Tạo Giải Đấu Mới</button>
            <button onclick="addManagerPrompt()" class="bg-purple-600 text-white text-xs px-3 py-1.5 rounded">+ Tạo Tài Khoản Manager</button>
          \`;
        }
        adminButtons.innerHTML = btns;
      } else {
        adminPanel.classList.add('hidden');
      }

      // Current Tournament Matches
      const activeTour = tournamentsData.find(t => t.id === selectedTourId);
      const matchesList = document.getElementById('matchesList');
      
      if (!activeTour || !activeTour.matches.length) {
        matchesList.innerHTML = '<p class="text-gray-500 italic">Chưa có trận đấu nào trong giải này.</p>';
      } else {
        matchesList.innerHTML = activeTour.matches.map(m => \`
          <div class="bg-white p-4 rounded-lg shadow border flex flex-col md:flex-row justify-between items-center gap-4">
            <div class="flex-1">
              <div class="font-bold text-gray-800">\${m.teamA}</div>
              <div class="text-xs text-gray-400">VS</div>
              <div class="font-bold text-gray-800">\${m.teamB}</div>
            </div>
            <div class="flex items-center gap-2">
              <div class="bg-gray-100 px-3 py-1 rounded text-center font-mono text-sm font-bold">
                Set 1: \${m.scoreA[0]}-\${m.scoreB[0]} | Set 2: \${m.scoreA[1]}-\${m.scoreB[1]} | Set 3: \${m.scoreA[2]}-\${m.scoreB[2]}
              </div>
              \${currentAuth ? \`<button onclick="editMatchPrompt('\${m.id}')" class="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">✏️ Sửa</button>\` : ''}
            </div>
          </div>
        \`).join('');
      }

      // Calculate Standings
      renderStandings(activeTour);
    }

    function renderStandings(tour) {
      if (!tour) return;
      const stats = {};
      tour.matches.forEach(m => {
        if (!stats[m.teamA]) stats[m.teamA] = { wins: 0, losses: 0, points: 0 };
        if (!stats[m.teamB]) stats[m.teamB] = { wins: 0, losses: 0, points: 0 };

        let winsA = 0, winsB = 0;
        for(let i=0; i<3; i++) {
          if (m.scoreA[i] > m.scoreB[i]) winsA++;
          else if (m.scoreB[i] > m.scoreA[i]) winsB++;
        }
        if (winsA > winsB) { stats[m.teamA].wins++; stats[m.teamA].points += 3; stats[m.teamB].losses++; }
        else if (winsB > winsA) { stats[m.teamB].wins++; stats[m.teamB].points += 3; stats[m.teamA].losses++; }
      });

      const sorted = Object.keys(stats).map(k => ({ name: k, ...stats[k] })).sort((a,b) => b.points - a.points);
      document.getElementById('standingsBody').innerHTML = sorted.map(s => \`
        <tr class="border-b bg-white">
          <td class="px-3 py-2 font-medium text-gray-900">\${s.name}</td>
          <td class="px-2 py-2 text-center text-green-600 font-bold">\${s.wins}</td>
          <td class="px-2 py-2 text-center text-red-500">\${s.losses}</td>
          <td class="px-2 py-2 text-center font-bold text-emerald-700">\${s.points}</td>
        </tr>
      \`).join('');
    }

    function switchTour(id) { selectedTourId = id; renderUI(); }
    function openLoginModal() { document.getElementById('loginModal').classList.remove('hidden'); }
    function closeLoginModal() { document.getElementById('loginModal').classList.add('hidden'); }

    async function handleLogin() {
      const u = document.getElementById('loginUser').value;
      const p = document.getElementById('loginPass').value;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: u, password: p })
      });
      if (res.ok) {
        currentAuth = await res.json();
        closeLoginModal();
        document.getElementById('authSection').innerHTML = \`
          <span class="text-xs">Xin chào, <b>\${currentAuth.name}</b> (\${currentAuth.role})</span>
          <button onclick="logout()" class="ml-2 text-xs text-red-200 underline">Thoát</button>
        \`;
        renderUI();
      } else {
        alert('Đăng nhập thất bại');
      }
    }

    function logout() { location.reload(); }

    async function addTournamentPrompt() {
      const name = prompt('Nhập tên giải đấu mới:');
      if (name) {
        await fetch('/api/tournaments', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name, role: currentAuth.role })
        });
      }
    }

    async function addMatchPrompt() {
      const teamA = prompt('Nhập tên Đội A / Cặp A:');
      const teamB = prompt('Nhập tên Đội B / Cặp B:');
      if (teamA && teamB) {
        await fetch(\`/api/tournaments/\${selectedTourId}/matches\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ teamA, teamB, role: currentAuth.role })
        });
      }
    }

    async function editMatchPrompt(matchId) {
      const sA1 = prompt('Điểm Đội A (Set 1):', '21');
      const sB1 = prompt('Điểm Đội B (Set 1):', '19');
      const sA2 = prompt('Điểm Đội A (Set 2):', '21');
      const sB2 = prompt('Điểm Đội B (Set 2):', '15');
      const sA3 = prompt('Điểm Đội A (Set 3 - nhập 0 nếu không có):', '0');
      const sB3 = prompt('Điểm Đội B (Set 3 - nhập 0 nếu không có):', '0');

      if (sA1 !== null && sB1 !== null) {
        await fetch(\`/api/tournaments/\${selectedTourId}/matches/\${matchId}\`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            scoreA: [parseInt(sA1), parseInt(sA2), parseInt(sA3)],
            scoreB: [parseInt(sB1), parseInt(sB2), parseInt(sB3)],
            role: currentAuth.role
          })
        });
      }
    }

    async function addManagerPrompt() {
      const username = prompt('Tên đăng nhập Manager mới:');
      const password = prompt('Mật khẩu Manager:');
      const name = prompt('Tên hiển thị Manager:');
      if (username && password) {
        await fetch('/api/users/manager', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ username, password, name, role: currentAuth.role })
        });
        alert('Tạo Manager thành công!');
      }
    }

    fetchTournaments();
  </script>
</body>
</html>
  `);
});

// --- 5. KHỞI CHẠY SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại port ${PORT}`);
});