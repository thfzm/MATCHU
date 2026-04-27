// ============================================================
// 맞춰 (Matchu) v2 - 백엔드
// 추가 기능: 시간대 슬롯 / 방장 권한 / 약속 확정 / 채팅 리액션
//          / @멘션 / 시스템 메시지 / 레이트 리밋 / 자동 정리
//          / 결과 카드 데이터 / iCal 내보내기 / WebSocket 실시간
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 시간 슬롯 정의 - 3슬롯 체계 (오전/오후/저녁)
const SLOTS = ['morning', 'afternoon', 'evening'];

// ------------------------------------------------------------
// 데이터 입출력 + 마이그레이션
// ------------------------------------------------------------
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.rooms) data.rooms = {};
    if (!data.lobbyChat) data.lobbyChat = [];
    // 구조 호환: members 값이 배열(구버전)이면 객체로 변환
    for (const name of Object.keys(data.rooms)) {
      const r = data.rooms[name];
      if (!r.members) r.members = {};
      for (const u of Object.keys(r.members)) {
        if (Array.isArray(r.members[u])) {
          // ['2026-05-01'] → { '2026-05-01': ['morning','afternoon','evening'] }
          const obj = {};
          for (const d of r.members[u]) obj[d] = SLOTS.slice();
          r.members[u] = obj;
        }
      }
      if (!r.chat) r.chat = [];
      if (!r.confirmed) r.confirmed = null;
      if (!r.lastActivity) r.lastActivity = r.createdAt || Date.now();
    }
    return data;
  } catch (err) {
    return { rooms: {}, lobbyChat: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ------------------------------------------------------------
// 룸 코드 생성 (혼동 글자 제외)
// ------------------------------------------------------------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(existing) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (existing.has(code));
  return code;
}

function sanitizeMessage(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, 500);
}

// @닉네임 패턴에서 멘션 추출 (방 멤버 목록과 교차)
function extractMentions(text, memberNames) {
  const mentions = new Set();
  // 한글/영문/숫자/_ 허용
  const re = /@([\w가-힣]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (memberNames.includes(m[1])) mentions.add(m[1]);
  }
  return Array.from(mentions);
}

// ------------------------------------------------------------
// 레이트 리밋 (메모리 토큰 버킷)
// 채팅 도배 방지: 사용자당 분당 30개
// ------------------------------------------------------------
const rateLimits = new Map(); // userName → { tokens, last }
function rateLimit(userName, max = 30, windowMs = 60_000) {
  const now = Date.now();
  let bucket = rateLimits.get(userName);
  if (!bucket) {
    bucket = { tokens: max, last: now };
    rateLimits.set(userName, bucket);
  }
  // 시간 경과만큼 토큰 회복
  const elapsed = now - bucket.last;
  bucket.tokens = Math.min(max, bucket.tokens + (elapsed / windowMs) * max);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ------------------------------------------------------------
// 자동 정리: 90일간 활동 없는 방 제거 (시간당 1회)
// ------------------------------------------------------------
const INACTIVITY_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
function cleanupInactive() {
  const data = readData();
  const cutoff = Date.now() - INACTIVITY_LIMIT_MS;
  let removed = 0;
  for (const name of Object.keys(data.rooms)) {
    if ((data.rooms[name].lastActivity || 0) < cutoff) {
      delete data.rooms[name];
      removed++;
    }
  }
  if (removed > 0) {
    writeData(data);
    console.log(`🧹 자동 정리: ${removed}개 방 제거`);
  }
}
setInterval(cleanupInactive, 60 * 60 * 1000);

function touch(room) { room.lastActivity = Date.now(); }

function publicRoomInfo(roomName, room) {
  return {
    roomName,
    isPublic: room.isPublic,
    memberCount: Object.keys(room.members || {}).length,
    createdAt: room.createdAt,
    confirmed: room.confirmed
  };
}

// ============================================================
// WebSocket: 실시간 푸시
// ============================================================
const wss = new WebSocketServer({ server });
// 채널 → ws set
const subscribers = new Map();
// ws → 메타 (userName, channel)
const wsMeta = new WeakMap();

function subscribe(ws, channel) {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(ws);
}
function unsubscribeAll(ws) {
  for (const set of subscribers.values()) set.delete(ws);
}
function broadcast(channel, payload) {
  const set = subscribers.get(channel);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'subscribe') {
      // 한 ws는 하나의 채널만 구독 (재구독 시 기존 구독 해제)
      unsubscribeAll(ws);
      subscribe(ws, data.channel);
      wsMeta.set(ws, { userName: data.userName, channel: data.channel });
    } else if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
  ws.on('close', () => unsubscribeAll(ws));
  ws.on('error', () => unsubscribeAll(ws));
});

// 시스템 메시지 생성 + 저장 + 브로드캐스트
function pushSystemMessage(roomName, room, text) {
  const msg = { user: '__system__', text, ts: Date.now(), system: true };
  room.chat.push(msg);
  if (room.chat.length > 500) room.chat = room.chat.slice(-500);
  broadcast(`room:${roomName}`, { type: 'chat', message: msg });
}

// ============================================================
// API: 공개방 목록
// ============================================================
app.get('/api/rooms', (req, res) => {
  const data = readData();
  const list = Object.entries(data.rooms)
    .filter(([_, r]) => r.isPublic)
    .map(([name, r]) => publicRoomInfo(name, r))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ ok: true, rooms: list });
});

// ============================================================
// API: 방 생성
// ============================================================
app.post('/api/room/create', (req, res) => {
  const { roomName, isPublic, userName } = req.body;
  if (!roomName || !roomName.trim() || !userName || !userName.trim()) {
    return res.status(400).json({ ok: false, message: '방 이름과 닉네임을 입력해주세요.' });
  }
  if (roomName.length > 30) {
    return res.status(400).json({ ok: false, message: '방 이름은 30자 이하로 입력해주세요.' });
  }
  const data = readData();
  if (data.rooms[roomName]) {
    return res.status(409).json({ ok: false, message: '이미 같은 이름의 방이 있습니다.' });
  }

  let code = null;
  if (!isPublic) {
    const existing = new Set(Object.values(data.rooms).map(r => r.code).filter(Boolean));
    code = generateCode(existing);
  }

  data.rooms[roomName] = {
    isPublic: !!isPublic,
    code,
    host: userName,            // 방장 = 만든 사람
    createdAt: Date.now(),
    lastActivity: Date.now(),
    members: { [userName]: {} },
    chat: [],
    confirmed: null            // { date, slot, confirmedBy, confirmedAt }
  };
  writeData(data);

  // 공개방이면 로비 목록 갱신
  if (isPublic) broadcast('lobby', { type: 'lobbyUpdate' });

  res.json({ ok: true, roomName, code, isPublic: !!isPublic });
});

// ============================================================
// API: 방 입장
// ============================================================
app.post('/api/room/enter', (req, res) => {
  let { roomName, code, userName } = req.body;
  if (!userName || !userName.trim()) {
    return res.status(400).json({ ok: false, message: '닉네임을 입력해주세요.' });
  }

  const data = readData();
  if (!roomName && code) {
    const found = Object.entries(data.rooms).find(([_, r]) => r.code === code.toUpperCase());
    if (!found) return res.status(404).json({ ok: false, message: '코드와 일치하는 방이 없습니다.' });
    roomName = found[0];
  }
  if (!roomName) return res.status(400).json({ ok: false, message: '방 이름 또는 코드 필요' });

  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false, message: '방을 찾을 수 없습니다.' });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false, message: '방 코드가 일치하지 않습니다.' });
  }

  const isNewMember = !room.members[userName];
  if (isNewMember) {
    room.members[userName] = {};
    touch(room);
    pushSystemMessage(roomName, room, `${userName}님이 입장했습니다.`);
  }
  writeData(data);

  if (isNewMember) {
    broadcast(`room:${roomName}`, { type: 'roomUpdate' });
    if (room.isPublic) broadcast('lobby', { type: 'lobbyUpdate' });
  }

  res.json({
    ok: true,
    roomName,
    isPublic: room.isPublic,
    code: room.code,
    host: room.host
  });
});

// ============================================================
// API: 가능한 시간대 저장
// 입력: { roomName, code, userName, dates: { 'YYYY-MM-DD': ['morning',...] } }
// ============================================================
app.post('/api/room/dates', (req, res) => {
  const { roomName, code, userName, dates } = req.body;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false, message: '방 없음' });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false, message: '인증 실패' });
  }
  if (!room.members[userName]) {
    return res.status(403).json({ ok: false, message: '먼저 방에 입장해주세요.' });
  }

  // 슬롯 검증: 정의된 슬롯만 허용
  const cleaned = {};
  if (dates && typeof dates === 'object') {
    for (const date of Object.keys(dates)) {
      const slots = (dates[date] || []).filter(s => SLOTS.includes(s));
      if (slots.length > 0) cleaned[date] = slots;
    }
  }
  room.members[userName] = cleaned;
  touch(room);
  writeData(data);

  broadcast(`room:${roomName}`, { type: 'roomUpdate' });
  res.json({ ok: true });
});

// ============================================================
// API: 약속 확정 (방장만 가능)
// ============================================================
app.post('/api/room/confirm', (req, res) => {
  const { roomName, code, userName, date, slot } = req.body;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false, message: '방 없음' });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false, message: '인증 실패' });
  }
  if (room.host !== userName) {
    return res.status(403).json({ ok: false, message: '방장만 확정할 수 있습니다.' });
  }

  if (date === null) {
    room.confirmed = null;
    pushSystemMessage(roomName, room, `${userName}님이 확정을 취소했습니다.`);
  } else {
    if (!SLOTS.includes(slot) && slot !== 'all') {
      return res.status(400).json({ ok: false, message: '잘못된 슬롯' });
    }
    room.confirmed = { date, slot, confirmedBy: userName, confirmedAt: Date.now() };
    const slotLabel = slot === 'all' ? '하루 종일' : { morning: '오전', afternoon: '오후', evening: '저녁' }[slot];
    pushSystemMessage(roomName, room, `📌 ${userName}님이 ${date} ${slotLabel}로 약속을 확정했습니다!`);
  }
  touch(room);
  writeData(data);

  broadcast(`room:${roomName}`, { type: 'roomUpdate' });
  if (room.isPublic) broadcast('lobby', { type: 'lobbyUpdate' });
  res.json({ ok: true });
});

// ============================================================
// API: 방 삭제 (방장만)
// ============================================================
app.delete('/api/room/:roomName', (req, res) => {
  const { roomName } = req.params;
  const { userName, code } = req.body;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false, message: '방 없음' });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false, message: '인증 실패' });
  }
  if (room.host !== userName) {
    return res.status(403).json({ ok: false, message: '방장만 삭제 가능' });
  }
  delete data.rooms[roomName];
  writeData(data);

  broadcast(`room:${roomName}`, { type: 'roomDeleted' });
  broadcast('lobby', { type: 'lobbyUpdate' });
  res.json({ ok: true });
});

// ============================================================
// API: 방 결과 + 정보 (집계 포함)
// ============================================================
function aggregate(room) {
  const memberNames = Object.keys(room.members);
  const totalMembers = memberNames.length;
  // (date, slot) 키별 참여자 누적
  const slotMap = {};
  for (const name of memberNames) {
    const dateMap = room.members[name] || {};
    for (const date of Object.keys(dateMap)) {
      for (const slot of dateMap[date]) {
        const key = `${date}|${slot}`;
        if (!slotMap[key]) slotMap[key] = [];
        slotMap[key].push(name);
      }
    }
  }
  const ranking = Object.entries(slotMap)
    .map(([key, names]) => {
      const [date, slot] = key.split('|');
      return {
        date, slot,
        count: names.length,
        members: names,
        isAllMatch: names.length === totalMembers && totalMembers > 0
      };
    })
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  return { totalMembers, memberNames, ranking };
}

app.get('/api/room/:roomName', (req, res) => {
  const { roomName } = req.params;
  const { code } = req.query;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false, message: '방 없음' });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false, message: '인증 실패' });
  }
  const agg = aggregate(room);
  res.json({
    ok: true,
    roomName,
    isPublic: room.isPublic,
    code: room.code,
    host: room.host,
    confirmed: room.confirmed,
    members: room.members,
    ...agg
  });
});

// ============================================================
// API: iCal (.ics) 내보내기 - 확정된 약속만
// ============================================================
app.get('/api/room/:roomName/ical', (req, res) => {
  const { roomName } = req.params;
  const { code } = req.query;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).send('not found');
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).send('unauthorized');
  }
  if (!room.confirmed) return res.status(400).send('not confirmed');

  const { date, slot } = room.confirmed;
  const slotTimes = {
    morning: ['09', '12'],
    afternoon: ['13', '18'],
    evening: ['18', '22'],
    all: ['09', '22']
  }[slot] || ['09', '22'];

  const dateCompact = date.replace(/-/g, '');
  const dtStart = `${dateCompact}T${slotTimes[0]}0000`;
  const dtEnd = `${dateCompact}T${slotTimes[1]}0000`;
  const uid = `matchu-${roomName}-${date}@matchu.local`;
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Matchu//KR',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${roomName}`,
    `DESCRIPTION:맞춰(Matchu)에서 확정된 약속`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(roomName)}.ics"`);
  res.send(ics);
});

// ============================================================
// 채팅 - 로비
// ============================================================
app.get('/api/chat/lobby', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const data = readData();
  res.json({ ok: true, messages: data.lobbyChat.filter(m => m.ts > since), now: Date.now() });
});

app.post('/api/chat/lobby', (req, res) => {
  const { userName, text } = req.body;
  const cleanText = sanitizeMessage(text);
  if (!userName || !cleanText) return res.status(400).json({ ok: false, message: '메시지 없음' });
  if (!rateLimit(userName)) return res.status(429).json({ ok: false, message: '너무 자주 보냈습니다.' });

  const data = readData();
  const msg = { user: userName, text: cleanText, ts: Date.now(), reactions: {} };
  data.lobbyChat.push(msg);
  if (data.lobbyChat.length > 200) data.lobbyChat = data.lobbyChat.slice(-200);
  writeData(data);

  broadcast('lobby', { type: 'chat', message: msg });
  res.json({ ok: true });
});

// 채팅 - 방
app.get('/api/chat/room/:roomName', (req, res) => {
  const { roomName } = req.params;
  const { code } = req.query;
  const since = parseInt(req.query.since) || 0;
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, messages: (room.chat || []).filter(m => m.ts > since), now: Date.now() });
});

app.post('/api/chat/room/:roomName', (req, res) => {
  const { roomName } = req.params;
  const { code, userName, text } = req.body;
  const cleanText = sanitizeMessage(text);
  const data = readData();
  const room = data.rooms[roomName];
  if (!room) return res.status(404).json({ ok: false });
  if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
    return res.status(401).json({ ok: false });
  }
  if (!userName || !cleanText) return res.status(400).json({ ok: false });
  if (!rateLimit(userName)) return res.status(429).json({ ok: false, message: '너무 자주 보냈습니다.' });

  const memberNames = Object.keys(room.members);
  const mentions = extractMentions(cleanText, memberNames);
  const msg = { user: userName, text: cleanText, ts: Date.now(), mentions, reactions: {} };
  if (!room.chat) room.chat = [];
  room.chat.push(msg);
  if (room.chat.length > 500) room.chat = room.chat.slice(-500);
  touch(room);
  writeData(data);

  broadcast(`room:${roomName}`, { type: 'chat', message: msg });
  res.json({ ok: true });
});

// ============================================================
// 채팅 리액션 (이모지)
// 입력: { ts, emoji, userName, channel: 'lobby' | 'room', roomName?, code? }
// ============================================================
app.post('/api/chat/react', (req, res) => {
  const { ts, emoji, userName, channel, roomName, code } = req.body;
  if (!ts || !emoji || !userName) return res.status(400).json({ ok: false });
  const data = readData();

  let msgList, broadcastChannel;
  if (channel === 'lobby') {
    msgList = data.lobbyChat;
    broadcastChannel = 'lobby';
  } else {
    const room = data.rooms[roomName];
    if (!room) return res.status(404).json({ ok: false });
    if (!room.isPublic && (!code || code.toUpperCase() !== room.code)) {
      return res.status(401).json({ ok: false });
    }
    msgList = room.chat;
    broadcastChannel = `room:${roomName}`;
  }

  const msg = msgList.find(m => m.ts === ts);
  if (!msg) return res.status(404).json({ ok: false });
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

  // 토글: 이미 했으면 취소, 아니면 추가
  const idx = msg.reactions[emoji].indexOf(userName);
  if (idx >= 0) msg.reactions[emoji].splice(idx, 1);
  else msg.reactions[emoji].push(userName);
  if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

  writeData(data);
  broadcast(broadcastChannel, { type: 'reaction', ts, reactions: msg.reactions });
  res.json({ ok: true, reactions: msg.reactions });
});

// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`✨ 맞춰 (Matchu) v2 실행 중: http://localhost:${PORT}`);
});
