// ============================================================
// 맞춰 (Matchu) v2 - 프론트엔드
// WebSocket 실시간 / 시간대 / 방장 권한 / 확정 / 리액션 / 멘션
// 알림 / 빠른 선택 / 결과 카드 / iCal / PWA
// ============================================================

const $ = (id) => document.getElementById(id);
const SLOTS = ['morning', 'afternoon', 'evening'];
const SLOT_LABEL = { morning: '오전', afternoon: '오후', evening: '저녁', all: '하루 종일' };

const state = {
  userName: '',
  // 방 컨텍스트
  roomName: '',
  roomCode: null,
  isPublic: true,
  isHost: false,
  // 본인 선택 - { 'YYYY-MM-DD': ['morning', ...] }
  myDates: {},
  viewYear: 0,
  viewMonth: 0,
  // 결과 캐시 (확정/멤버/탭 렌더용)
  lastResult: null,
  // 채팅
  lastLobbyChatTs: 0,
  lastRoomChatTs: 0,
  // WebSocket
  ws: null,
  wsRetry: 0,
  currentChannel: null,
  // 알림
  notifyEnabled: false,
  // 메시지 ID → DOM 매핑 (리액션 갱신용)
  msgEls: new Map(),
  // 마지막 갱신 시각
  lastFetchedAt: null,
  labelTimer: null
};

const screens = {
  nickname: $('nicknameScreen'),
  lobby: $('lobbyScreen'),
  room: $('roomScreen')
};

// ============================================================
// 0. 테마 토글
// ============================================================
(function initTheme() {
  const saved = localStorage.getItem('matchu_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
})();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('matchu_theme', theme);
}

$('themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ============================================================
// 0-2. 알림 권한
// ============================================================
$('notifyToggle').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    alert('이 브라우저는 알림을 지원하지 않습니다.');
    return;
  }
  if (Notification.permission === 'granted') {
    state.notifyEnabled = !state.notifyEnabled;
    $('notifyToggle').classList.toggle('active', state.notifyEnabled);
    $('notifyToggle').title = state.notifyEnabled ? '알림 켜짐' : '알림 꺼짐';
  } else {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      state.notifyEnabled = true;
      $('notifyToggle').classList.add('active');
    }
  }
});

if ('Notification' in window && Notification.permission === 'granted') {
  state.notifyEnabled = true;
  $('notifyToggle').classList.add('active');
}

function notify(title, body) {
  if (!state.notifyEnabled || document.hasFocus()) return;
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body, icon: '/icon.svg', tag: 'matchu' });
}

// ============================================================
// 0-3. PWA Service Worker 등록
// ============================================================
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW 등록 실패:', err));
  });
}

// ============================================================
// 0-4. 브랜드 클릭 → 로비
// ============================================================
$('brandHome').addEventListener('click', () => {
  if (state.userName) goLobby();
});

// ============================================================
// 1. 화면 라우팅
// ============================================================
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

(function bootstrap() {
  const savedName = localStorage.getItem('matchu_nickname');
  if (savedName) {
    state.userName = savedName;
    $('nicknameInput').value = savedName;
  }

  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  const codeFromUrl = params.get('code');

  if (state.userName) {
    goLobby();
    if (codeFromUrl) {
      $('codeInput').value = codeFromUrl.toUpperCase();
      enterByCode();
    } else if (roomFromUrl) {
      enterRoomByName(roomFromUrl);
    }
  } else {
    showScreen('nickname');
    $('nicknameInput').focus();
  }

  connectWS();
})();

// ============================================================
// 2. 닉네임
// ============================================================
$('enterLobbyBtn').addEventListener('click', submitNickname);
$('nicknameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNickname(); });

function submitNickname() {
  const name = $('nicknameInput').value.trim();
  if (!name) return showMsg($('nicknameMsg'), '닉네임을 입력해주세요.', 'error');
  if (name.length > 20) return showMsg($('nicknameMsg'), '20자 이내', 'error');
  state.userName = name;
  localStorage.setItem('matchu_nickname', name);
  goLobby();
}

// ============================================================
// 3. WebSocket
// ============================================================
function connectWS() {
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      $('wsStatus').className = 'ws-status connected';
      state.wsRetry = 0;
      // 현재 채널이 있으면 재구독
      if (state.currentChannel) subscribeWS(state.currentChannel);
    });

    ws.addEventListener('close', () => {
      $('wsStatus').className = 'ws-status disconnected';
      state.ws = null;
      // 지수 백오프 재연결 (최대 30초)
      const delay = Math.min(1000 * Math.pow(2, state.wsRetry++), 30000);
      setTimeout(connectWS, delay);
    });

    ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handleWSMessage(data);
    });
  } catch {
    $('wsStatus').className = 'ws-status disconnected';
  }
}

function subscribeWS(channel) {
  state.currentChannel = channel;
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({
      type: 'subscribe',
      channel,
      userName: state.userName
    }));
  }
}

function handleWSMessage(data) {
  if (data.type === 'chat') {
    if (state.currentChannel === 'lobby') {
      appendMessage($('lobbyChatBox'), data.message, false);
      state.lastLobbyChatTs = Math.max(state.lastLobbyChatTs, data.message.ts);
    } else {
      appendMessage($('roomChatBox'), data.message, false);
      state.lastRoomChatTs = Math.max(state.lastRoomChatTs, data.message.ts);
      // 멘션 알림
      if (data.message.mentions && data.message.mentions.includes(state.userName)
          && data.message.user !== state.userName) {
        notify(`@${data.message.user}님이 멘션`, data.message.text);
      }
    }
  } else if (data.type === 'roomUpdate') {
    if (screens.room.classList.contains('active')) {
      renderResult();
    }
  } else if (data.type === 'lobbyUpdate') {
    if (screens.lobby.classList.contains('active')) {
      loadRooms();
    }
  } else if (data.type === 'reaction') {
    updateMessageReactions(data.ts, data.reactions);
  } else if (data.type === 'roomDeleted') {
    if (screens.room.classList.contains('active')) {
      alert('방이 삭제되었습니다.');
      goLobby();
    }
  }
}

// ============================================================
// 4. 로비
// ============================================================
function goLobby() {
  state.roomName = '';
  state.roomCode = null;
  state.isHost = false;
  if (state.labelTimer) { clearInterval(state.labelTimer); state.labelTimer = null; }
  updateUrl({});
  showScreen('lobby');
  loadRooms();
  loadInitialChat($('lobbyChatBox'), '/api/chat/lobby', 'lobby');
  subscribeWS('lobby');
}

async function loadRooms() {
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    renderRoomList(data.rooms || []);
  } catch (err) { console.error(err); }
}

function renderRoomList(rooms) {
  const list = $('roomList');
  list.innerHTML = '';
  if (rooms.length === 0) {
    list.innerHTML = '<div class="empty-rooms">아직 공개방이 없어요.<br/>첫 방을 만들어보세요!</div>';
    return;
  }
  for (const r of rooms) {
    const item = document.createElement('div');
    item.className = 'room-item';
    const confirmedTag = r.confirmed ? '<span class="room-item-confirmed">📌 확정</span>' : '';
    item.innerHTML = `
      <div>
        <div class="room-item-name">${escapeHtml(r.roomName)}</div>
        <div class="room-item-meta">참여자 ${r.memberCount}명 ${confirmedTag}</div>
      </div>
      <span class="room-item-arrow">→</span>
    `;
    item.addEventListener('click', () => enterRoomByName(r.roomName));
    list.appendChild(item);
  }
}

// ============================================================
// 5. 방 만들기 모달
// ============================================================
$('openCreateBtn').addEventListener('click', () => {
  $('newRoomName').value = '';
  $('createMsg').textContent = '';
  document.querySelector('input[name="visibility"][value="public"]').checked = true;
  $('createModal').classList.add('show');
  setTimeout(() => $('newRoomName').focus(), 50);
});
$('cancelCreateBtn').addEventListener('click', () => $('createModal').classList.remove('show'));
$('createModal').querySelector('.modal-backdrop').addEventListener('click', () => $('createModal').classList.remove('show'));
$('confirmCreateBtn').addEventListener('click', createRoom);
$('newRoomName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });

async function createRoom() {
  const roomName = $('newRoomName').value.trim();
  const isPublic = document.querySelector('input[name="visibility"]:checked').value === 'public';
  const msg = $('createMsg');
  if (!roomName) return showMsg(msg, '방 이름을 입력해주세요.', 'error');

  try {
    const res = await fetch('/api/room/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, isPublic, userName: state.userName })
    });
    const data = await res.json();
    if (!data.ok) return showMsg(msg, data.message || '생성 실패', 'error');

    $('createModal').classList.remove('show');
    if (!isPublic && data.code) {
      alert(`✨ 비공개 방이 생성되었습니다.\n\n방 코드: ${data.code}\n\n친구에게 공유하세요. 방 안에서도 확인 가능합니다.`);
    }
    enterRoom(data.roomName, data.code, data.isPublic, state.userName);
  } catch (err) {
    showMsg(msg, '서버 오류: ' + err.message, 'error');
  }
}

// ============================================================
// 6. 방 입장
// ============================================================
$('enterCodeBtn').addEventListener('click', enterByCode);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterByCode(); });
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

async function enterByCode() {
  const code = $('codeInput').value.trim().toUpperCase();
  const msg = $('lobbyMsg');
  if (!code) return showMsg(msg, '코드를 입력해주세요.', 'error');
  try {
    const res = await fetch('/api/room/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userName: state.userName })
    });
    const data = await res.json();
    if (!data.ok) return showMsg(msg, data.message, 'error');
    enterRoom(data.roomName, data.code, data.isPublic, data.host);
  } catch (err) { showMsg(msg, '서버 오류: ' + err.message, 'error'); }
}

async function enterRoomByName(roomName) {
  try {
    const res = await fetch('/api/room/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, userName: state.userName })
    });
    const data = await res.json();
    if (!data.ok) {
      if (res.status === 401) {
        const code = window.prompt(`'${roomName}' 은(는) 비공개 방입니다.\n방 코드:`);
        if (!code) return;
        const res2 = await fetch('/api/room/enter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, code: code.trim().toUpperCase(), userName: state.userName })
        });
        const data2 = await res2.json();
        if (!data2.ok) return alert(data2.message || '입장 실패');
        enterRoom(data2.roomName, data2.code, data2.isPublic, data2.host);
      } else {
        alert(data.message || '입장 실패');
      }
      return;
    }
    enterRoom(data.roomName, data.code, data.isPublic, data.host);
  } catch (err) { alert('서버 오류: ' + err.message); }
}

function enterRoom(roomName, code, isPublic, host) {
  state.roomName = roomName;
  state.roomCode = code || null;
  state.isPublic = !!isPublic;
  state.isHost = host === state.userName;
  state.myDates = {};
  state.lastRoomChatTs = 0;
  state.msgEls.clear();

  $('currentRoom').textContent = roomName;
  $('currentUser').textContent = state.userName;
  $('chatRoomLabel').textContent = roomName;

  $('roomVisibility').textContent = isPublic ? '공개' : '비공개';
  $('roomVisibility').className = isPublic ? 'vis-badge' : 'vis-badge private';
  $('hostBadge').style.display = state.isHost ? 'inline-block' : 'none';
  $('deleteRoomBtn').style.display = state.isHost ? 'inline-block' : 'none';

  if (code) {
    $('codeBadge').textContent = code;
    $('codeBadge').style.display = 'inline-block';
  } else {
    $('codeBadge').style.display = 'none';
  }

  updateUrl(isPublic ? { room: roomName } : { code });

  const today = new Date();
  state.viewYear = today.getFullYear();
  state.viewMonth = today.getMonth();

  showScreen('room');
  subscribeWS(`room:${roomName}`);

  if (!state.labelTimer) state.labelTimer = setInterval(updateLastUpdatedLabel, 1000);

  // 초기 로드
  Promise.all([
    renderResult(),
    loadInitialChat($('roomChatBox'), buildRoomChatUrl(), 'room')
  ]).then(() => {
    // 결과에서 본인 데이터 가져와서 달력에 반영
    if (state.lastResult && state.lastResult.members[state.userName]) {
      state.myDates = { ...state.lastResult.members[state.userName] };
    }
    renderCalendar();
  });
}

$('backToLobbyBtn').addEventListener('click', goLobby);

// 방 삭제
$('deleteRoomBtn').addEventListener('click', async () => {
  if (!confirm('정말 이 방을 삭제하시겠습니까?\n모든 데이터(채팅 포함)가 사라집니다.')) return;
  try {
    const res = await fetch(`/api/room/${encodeURIComponent(state.roomName)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: state.userName, code: state.roomCode })
    });
    const data = await res.json();
    if (!data.ok) return alert(data.message || '삭제 실패');
    goLobby();
  } catch (err) { alert('오류: ' + err.message); }
});

// ============================================================
// 7. 달력 + 시간대 셀
// ============================================================
$('prevMonth').addEventListener('click', () => {
  state.viewMonth--;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  renderCalendar();
});
$('nextMonth').addEventListener('click', () => {
  state.viewMonth++;
  if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  renderCalendar();
});

function renderCalendar() {
  const year = state.viewYear, month = state.viewMonth;
  $('monthLabel').textContent = `${year}년 ${month + 1}월`;
  const cal = $('calendar');
  cal.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  const confirmed = state.lastResult && state.lastResult.confirmed;

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'day empty';
    cal.appendChild(empty);
  }

  for (let d = 1; d <= lastDate; d++) {
    const dateObj = new Date(year, month, d);
    const dateStr = formatDate(dateObj);

    const cell = document.createElement('div');
    cell.className = 'day';
    cell.dataset.date = dateStr;

    if (dateObj.getTime() === today.getTime()) cell.classList.add('today');
    if (dateObj < today) cell.classList.add('disabled');
    if (confirmed && confirmed.date === dateStr) cell.classList.add('confirmed-cell');

    const num = document.createElement('span');
    num.className = 'day-num';
    num.textContent = d;
    cell.appendChild(num);

    // 선택된 슬롯 (본인 기준)
    const mySlots = state.myDates[dateStr] || [];
    if (mySlots.length === SLOTS.length) cell.classList.add('full-selection');
    else if (mySlots.length > 0) cell.classList.add('has-selection');

    // 슬롯 도트
    const dots = document.createElement('div');
    dots.className = 'slot-dots';
    for (const slot of SLOTS) {
      const dot = document.createElement('span');
      dot.className = 'slot-dot' + (mySlots.includes(slot) ? ' active' : '');
      dot.dataset.slot = slot;
      dot.title = SLOT_LABEL[slot];
      if (!cell.classList.contains('disabled')) {
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSlot(dateStr, slot);
        });
      }
      dots.appendChild(dot);
    }
    cell.appendChild(dots);

    if (!cell.classList.contains('disabled')) {
      // 셀 본체 클릭: 전체 토글 (모두 선택 ↔ 모두 해제)
      cell.addEventListener('click', () => toggleAll(dateStr));
    }
    cal.appendChild(cell);
  }
  updateSelectedCount();
}

function toggleAll(dateStr) {
  const cur = state.myDates[dateStr] || [];
  if (cur.length === SLOTS.length) {
    delete state.myDates[dateStr];
  } else {
    state.myDates[dateStr] = SLOTS.slice();
  }
  renderCalendar();
}

function toggleSlot(dateStr, slot) {
  const cur = state.myDates[dateStr] || [];
  const idx = cur.indexOf(slot);
  if (idx >= 0) cur.splice(idx, 1);
  else cur.push(slot);
  if (cur.length === 0) delete state.myDates[dateStr];
  else state.myDates[dateStr] = cur;
  renderCalendar();
}

function updateSelectedCount() {
  const total = Object.values(state.myDates).reduce((s, arr) => s + arr.length, 0);
  const dateCount = Object.keys(state.myDates).length;
  $('selectedCount').textContent = `${dateCount}일 / ${total}슬롯 선택`;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 빠른 선택
document.querySelectorAll('[data-quick]').forEach(btn => {
  btn.addEventListener('click', () => applyQuickSelect(btn.dataset.quick));
});

function applyQuickSelect(kind) {
  const year = state.viewYear, month = state.viewMonth;
  const lastDate = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  if (kind === 'clear') {
    // 현재 보고 있는 달의 모든 날짜 제거
    for (let d = 1; d <= lastDate; d++) {
      const ds = formatDate(new Date(year, month, d));
      delete state.myDates[ds];
    }
  } else {
    for (let d = 1; d <= lastDate; d++) {
      const dateObj = new Date(year, month, d);
      if (dateObj < today) continue;
      const ds = formatDate(dateObj);
      const dow = dateObj.getDay();
      const isWeekend = dow === 0 || dow === 6;
      let take = false;
      if (kind === 'all') take = true;
      else if (kind === 'weekdays' && !isWeekend) take = true;
      else if (kind === 'weekends' && isWeekend) take = true;
      if (take) state.myDates[ds] = SLOTS.slice();
    }
  }
  renderCalendar();
}

// ============================================================
// 8. 저장
// ============================================================
$('saveBtn').addEventListener('click', async () => {
  const msg = $('saveMsg');
  try {
    const res = await fetch('/api/room/dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomName: state.roomName,
        code: state.roomCode,
        userName: state.userName,
        dates: state.myDates
      })
    });
    const data = await res.json();
    if (!data.ok) return showMsg(msg, data.message || '저장 실패', 'error');
    showMsg(msg, '저장되었습니다!', 'success');
    setTimeout(() => { msg.textContent = ''; msg.className = 'msg'; }, 2000);
  } catch (err) { showMsg(msg, '서버 오류: ' + err.message, 'error'); }
});

// ============================================================
// 9. 결과 + 탭
// ============================================================
async function renderResult() {
  try {
    const url = new URL(`/api/room/${encodeURIComponent(state.roomName)}`, location.origin);
    if (state.roomCode) url.searchParams.set('code', state.roomCode);
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    state.lastResult = data;
    state.lastFetchedAt = new Date();
    updateLastUpdatedLabel();
    renderResultPanel(data);
    renderConfirmBanner(data);
    renderMemberPanel(data);
    // 확정/멤버 변경에 따라 달력 표시도 동기화
    if (screens.room.classList.contains('active')) {
      // 본인 데이터가 서버 기준으로 갱신되었을 수 있음 (다른 기기 등) → 머지하지 않고 표시만 일관성
      const cal = $('calendar');
      if (cal && cal.children.length > 0) {
        // 확정 셀 강조 갱신
        cal.querySelectorAll('.day').forEach(c => c.classList.remove('confirmed-cell'));
        if (data.confirmed) {
          const cell = cal.querySelector(`[data-date="${data.confirmed.date}"]`);
          if (cell) cell.classList.add('confirmed-cell');
        }
      }
    }
  } catch (err) { console.error(err); }
}

function renderResultPanel(data) {
  $('memberCount').textContent = data.totalMembers;
  $('memberList').textContent = data.memberNames.join(', ');

  const pending = data.memberNames.filter(name => {
    const dates = data.members[name];
    return !dates || Object.keys(dates).length === 0;
  });
  const pendingEl = $('pendingInfo');
  if (pending.length > 0) {
    pendingEl.style.display = 'block';
    pendingEl.textContent = `⏳ ${pending.length}명 미응답: ${pending.join(', ')}`;
  } else pendingEl.style.display = 'none';

  const list = $('resultList');
  list.innerHTML = '';
  if (!data.ranking || data.ranking.length === 0) {
    list.innerHTML = '<li class="empty-result">아직 선택된 시간이 없어요.<br/>달력에서 날짜·시간대를 골라보세요!</li>';
    return;
  }

  for (const item of data.ranking) {
    const li = document.createElement('li');
    const isConfirmed = data.confirmed && data.confirmed.date === item.date && data.confirmed.slot === item.slot;
    li.className = 'result-item' + (item.isAllMatch ? ' all-match' : '') + (isConfirmed ? ' confirmed' : '');
    const dateLabel = formatPretty(item.date);
    const allTag = item.isAllMatch ? ' 🎉' : '';
    const confirmedTag = isConfirmed ? ' 📌' : '';

    let actions = '';
    if (state.isHost) {
      if (isConfirmed) {
        actions = `<div class="result-item-actions"><button data-action="unconfirm">확정 취소</button></div>`;
      } else {
        actions = `<div class="result-item-actions"><button data-action="confirm" data-date="${item.date}" data-slot="${item.slot}">📌 이 시간으로 확정</button></div>`;
      }
    }

    li.innerHTML = `
      <div class="result-row">
        <span class="result-date">${escapeHtml(dateLabel)}<span class="result-slot">${SLOT_LABEL[item.slot]}</span>${allTag}${confirmedTag}</span>
        <span class="result-count">${item.count} / ${data.totalMembers}명</span>
      </div>
      <div class="result-members">참여 가능: ${escapeHtml(item.members.join(', '))}</div>
      ${actions}
    `;
    list.appendChild(li);
  }

  // 확정 버튼 이벤트 위임
  list.querySelectorAll('[data-action="confirm"]').forEach(btn => {
    btn.addEventListener('click', () => confirmAppointment(btn.dataset.date, btn.dataset.slot));
  });
  list.querySelectorAll('[data-action="unconfirm"]').forEach(btn => {
    btn.addEventListener('click', () => confirmAppointment(null, null));
  });
}

function renderConfirmBanner(data) {
  const banner = $('confirmBanner');
  const ical = $('icalBtn');
  if (!data.confirmed) {
    banner.style.display = 'none';
    ical.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  ical.style.display = 'inline-block';
  const c = data.confirmed;
  const slotText = SLOT_LABEL[c.slot] || c.slot;
  banner.innerHTML = `
    <div>
      <div class="confirm-text">📌 ${escapeHtml(formatPretty(c.date))} ${slotText} 확정</div>
      <div class="confirm-meta">방장 ${escapeHtml(c.confirmedBy)}님이 확정</div>
    </div>
    ${state.isHost ? `<button id="unconfirmBtn">확정 취소</button>` : ''}
  `;
  if (state.isHost) {
    $('unconfirmBtn').addEventListener('click', () => confirmAppointment(null, null));
  }
}

async function confirmAppointment(date, slot) {
  try {
    const res = await fetch('/api/room/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomName: state.roomName,
        code: state.roomCode,
        userName: state.userName,
        date, slot
      })
    });
    const data = await res.json();
    if (!data.ok) alert(data.message || '실패');
    // WebSocket으로 갱신됨
  } catch (err) { alert('오류: ' + err.message); }
}

// 탭 전환
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const target = btn.dataset.tab === 'ranking' ? $('resultList') : $('memberPanel');
    target.classList.add('active');
  });
});

function renderMemberPanel(data) {
  const panel = $('memberPanel');
  panel.innerHTML = '';
  if (data.memberNames.length === 0) {
    panel.innerHTML = '<div class="empty-result">참여자가 없어요.</div>';
    return;
  }
  for (const name of data.memberNames) {
    const dates = data.members[name] || {};
    const dateKeys = Object.keys(dates).sort();
    const card = document.createElement('div');
    card.className = 'member-card';
    const isYou = name === state.userName;
    const isHost = name === data.host;

    let chips;
    if (dateKeys.length === 0) {
      chips = '<span class="date-chip empty">아직 응답 없음</span>';
    } else {
      chips = dateKeys.map(d => {
        const slots = dates[d];
        const slotTxt = slots.length === SLOTS.length ? '종일' : slots.map(s => SLOT_LABEL[s]).join('·');
        return `<span class="date-chip">${escapeHtml(formatPretty(d))} ${slotTxt}</span>`;
      }).join('');
    }

    card.innerHTML = `
      <div class="member-card-head">
        <span class="member-card-name">
          ${isHost ? '👑 ' : ''}${escapeHtml(name)}
          ${isYou ? '<span class="you-badge">나</span>' : ''}
        </span>
        <span class="member-card-count">${dateKeys.length}일</span>
      </div>
      <div class="member-card-dates">${chips}</div>
    `;
    panel.appendChild(card);
  }
}

function formatPretty(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ['일','월','화','수','목','금','토'][date.getDay()];
  return `${y}.${String(m).padStart(2,'0')}.${String(d).padStart(2,'0')} (${wd})`;
}

function updateLastUpdatedLabel() {
  if (!state.lastFetchedAt) return;
  const diff = Math.floor((Date.now() - state.lastFetchedAt.getTime()) / 1000);
  let label;
  if (diff < 3) label = '방금';
  else if (diff < 60) label = `${diff}초 전`;
  else if (diff < 3600) label = `${Math.floor(diff/60)}분 전`;
  else label = `${Math.floor(diff/3600)}시간 전`;
  $('lastUpdated').textContent = label;
}

// ============================================================
// 10. 채팅
// ============================================================
function buildRoomChatUrl() {
  const url = new URL(`/api/chat/room/${encodeURIComponent(state.roomName)}`, location.origin);
  if (state.roomCode) url.searchParams.set('code', state.roomCode);
  return url.toString();
}

async function loadInitialChat(box, baseUrl, scope) {
  box.innerHTML = '';
  state.msgEls.clear();
  try {
    const res = await fetch(baseUrl);
    const data = await res.json();
    if (!data.ok) return;
    if (data.messages.length === 0) {
      box.innerHTML = '<div class="chat-empty">아직 메시지가 없어요.<br/>첫 인사를 남겨보세요 👋</div>';
      return;
    }
    for (const m of data.messages) appendMessage(box, m, true);
    if (scope === 'lobby') state.lastLobbyChatTs = data.messages[data.messages.length - 1].ts;
    else state.lastRoomChatTs = data.messages[data.messages.length - 1].ts;
    box.scrollTop = box.scrollHeight;
  } catch (err) { console.error(err); }
}

function appendMessage(box, m, skipScrollCheck) {
  const empty = box.querySelector('.chat-empty');
  if (empty) empty.remove();

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const div = document.createElement('div');
  div.dataset.ts = m.ts;
  if (m.system) {
    div.className = 'chat-msg system';
    div.textContent = m.text;
  } else {
    let cls = 'chat-msg';
    if (m.user === state.userName) cls += ' mine';
    if (m.mentions && m.mentions.includes(state.userName)) cls += ' mention';
    div.className = cls;

    const reactionsHtml = renderReactions(m.reactions, m.ts);
    div.innerHTML = `
      <div class="chat-msg-head">
        <span class="name">${escapeHtml(m.user)}</span>
        <span class="time">${formatTime(m.ts)}</span>
      </div>
      <div class="text">${highlightMentions(m.text, m.mentions || [])}</div>
      <div class="chat-reactions">${reactionsHtml}</div>
      <button class="react-trigger" title="리액션 추가">😊</button>
    `;
    // 리액션 칩 클릭 (토글)
    div.querySelectorAll('.reaction-chip').forEach(chip => {
      chip.addEventListener('click', () => sendReaction(m.ts, chip.dataset.emoji));
    });
    // 리액션 추가 버튼
    div.querySelector('.react-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      openEmojiPicker(e.target, m.ts);
    });
  }

  box.appendChild(div);
  state.msgEls.set(m.ts, div);

  if (skipScrollCheck || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderReactions(reactions, ts) {
  if (!reactions) return '';
  return Object.entries(reactions).map(([emoji, users]) => {
    if (users.length === 0) return '';
    const mine = users.includes(state.userName) ? ' mine' : '';
    return `<span class="reaction-chip${mine}" data-emoji="${emoji}" title="${escapeHtml(users.join(', '))}">${emoji} <span class="reaction-count">${users.length}</span></span>`;
  }).join('');
}

function highlightMentions(text, mentions) {
  let safe = escapeHtml(text);
  // @닉네임 강조 - 이미 escape되어있어 안전
  safe = safe.replace(/@([\w가-힣]+)/g, (m, name) => {
    if (mentions.includes(name)) return `<span class="mention-tag">@${name}</span>`;
    return m;
  });
  return safe;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function updateMessageReactions(ts, reactions) {
  const el = state.msgEls.get(ts);
  if (!el) return;
  const container = el.querySelector('.chat-reactions');
  if (!container) return;
  container.innerHTML = renderReactions(reactions, ts);
  container.querySelectorAll('.reaction-chip').forEach(chip => {
    chip.addEventListener('click', () => sendReaction(ts, chip.dataset.emoji));
  });
}

async function sendReaction(ts, emoji) {
  const isLobby = state.currentChannel === 'lobby';
  try {
    await fetch('/api/chat/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts, emoji, userName: state.userName,
        channel: isLobby ? 'lobby' : 'room',
        roomName: isLobby ? null : state.roomName,
        code: isLobby ? null : state.roomCode
      })
    });
  } catch (err) { console.error(err); }
}

// 이모지 피커
function openEmojiPicker(triggerEl, ts) {
  const picker = $('emojiPicker');
  const rect = triggerEl.getBoundingClientRect();
  picker.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  picker.style.left = (window.scrollX + rect.left - 100) + 'px';
  picker.classList.add('show');
  picker.dataset.ts = ts;
}

document.addEventListener('click', (e) => {
  const picker = $('emojiPicker');
  if (picker.classList.contains('show') && !picker.contains(e.target) && !e.target.classList.contains('react-trigger')) {
    picker.classList.remove('show');
  }
});

$('emojiPicker').querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const ts = parseInt($('emojiPicker').dataset.ts);
    sendReaction(ts, btn.dataset.emoji);
    $('emojiPicker').classList.remove('show');
  });
});

// 채팅 전송
$('lobbyChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('lobbyChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await fetch('/api/chat/lobby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: state.userName, text })
    });
  } catch (err) { console.error(err); }
});

$('roomChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('roomChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await fetch(`/api/chat/room/${encodeURIComponent(state.roomName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: state.userName,
        code: state.roomCode,
        text
      })
    });
  } catch (err) { console.error(err); }
});

// ============================================================
// 11. 링크 공유
// ============================================================
$('shareBtn').addEventListener('click', async () => {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('code');
  if (state.isPublic) url.searchParams.set('room', state.roomName);
  else url.searchParams.set('code', state.roomCode);
  const link = url.toString();
  try {
    await navigator.clipboard.writeText(link);
    flashBtn($('shareBtn'), '✅ 복사됨!');
  } catch { window.prompt('아래 링크를 복사하세요:', link); }
});

function flashBtn(btn, text) {
  const o = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = o; }, 1500);
}

// ============================================================
// 12. 결과 카드 (Canvas 이미지)
// ============================================================
$('cardBtn').addEventListener('click', () => {
  if (!state.lastResult) return;
  drawResultCard(state.lastResult);
  $('cardModal').classList.add('show');
});
$('closeCardBtn').addEventListener('click', () => $('cardModal').classList.remove('show'));
$('cardModal').querySelector('.modal-backdrop').addEventListener('click', () => $('cardModal').classList.remove('show'));
$('downloadCardBtn').addEventListener('click', () => {
  const canvas = $('resultCanvas');
  const link = document.createElement('a');
  link.download = `${state.roomName}_결과.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

function drawResultCard(data) {
  const canvas = $('resultCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // 배경 그라디언트
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#6366f1');
  grad.addColorStop(0.5, '#8b5cf6');
  grad.addColorStop(1, '#ec4899');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 반투명 패널
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  roundRect(ctx, 40, 40, W - 80, H - 80, 24);
  ctx.fill();

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px -apple-system, sans-serif';
  ctx.fillText('맞춰 · Matchu', 70, 90);

  ctx.fillStyle = '#6366f1';
  ctx.font = 'bold 32px -apple-system, sans-serif';
  ctx.fillText(state.roomName, 70, 140);

  ctx.fillStyle = '#64748b';
  ctx.font = '15px -apple-system, sans-serif';
  ctx.fillText(`참여자 ${data.totalMembers}명: ${data.memberNames.join(', ')}`, 70, 170);

  let y = 215;
  if (data.confirmed) {
    // 확정 박스
    const cgrad = ctx.createLinearGradient(70, 0, W - 70, 0);
    cgrad.addColorStop(0, '#6366f1');
    cgrad.addColorStop(1, '#ec4899');
    ctx.fillStyle = cgrad;
    roundRect(ctx, 70, y, W - 140, 80, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.fillText('📌 확정된 약속', 90, y + 30);
    ctx.font = 'bold 22px -apple-system, sans-serif';
    const c = data.confirmed;
    ctx.fillText(`${formatPretty(c.date)} ${SLOT_LABEL[c.slot]}`, 90, y + 62);
    y += 105;
  } else {
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.fillText('🏆 가장 많이 겹친 시간', 70, y);
    y += 30;

    const top = (data.ranking || []).slice(0, 3);
    if (top.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px -apple-system, sans-serif';
      ctx.fillText('아직 응답 없음', 70, y);
    } else {
      for (const item of top) {
        ctx.fillStyle = item.isAllMatch ? '#6366f1' : '#0f172a';
        ctx.font = item.isAllMatch ? 'bold 18px -apple-system, sans-serif' : '16px -apple-system, sans-serif';
        const star = item.isAllMatch ? '🎉 ' : '· ';
        ctx.fillText(`${star}${formatPretty(item.date)} ${SLOT_LABEL[item.slot]} - ${item.count}/${data.totalMembers}명`, 70, y);
        y += 28;
      }
    }
  }

  // 푸터
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText('맞춰 · matchu', 70, H - 60);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================
// 13. iCal 다운로드
// ============================================================
$('icalBtn').addEventListener('click', () => {
  const url = new URL(`/api/room/${encodeURIComponent(state.roomName)}/ical`, location.origin);
  if (state.roomCode) url.searchParams.set('code', state.roomCode);
  window.location.href = url.toString();
});

// ============================================================
// 14. URL 동기화
// ============================================================
function updateUrl(params) {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('code');
  if (params.room) url.searchParams.set('room', params.room);
  if (params.code) url.searchParams.set('code', params.code);
  window.history.replaceState({}, '', url.toString());
}

// ============================================================
// 유틸
// ============================================================
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + (type || '');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
