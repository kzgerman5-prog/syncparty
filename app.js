'use strict';

const $ = id => document.getElementById(id);
function getSessionId() {
  try {
    let id = sessionStorage.getItem('syncparty-session');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('syncparty-session', id);
    }
    return id;
  } catch { return crypto.randomUUID(); }
}

const state = {
  role: null,
  hostSessionId: null,
  code: '',
  name: '',
  sessionId: getSessionId(),
  client: null,
  channel: null,
  connected: false,
  mode: 'youtube',
  video: null,
  player: null,
  playerGeneration: 0,
  ready: false,
  suppress: false,
  lastState: null,
  chatSeen: new Set(),
  mentionCandidates: [],
  mentionIndex: 0,
  bannedSessions: new Set(),
  pendingMentions: [],
  toastTimer: null,
  callWindow: null,
};

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOSTED_CALL_DOMAIN = 'meet.ffmuc.net';

function setTab(tab) {
  $('createTab').classList.toggle('active', tab === 'create');
  $('joinTab').classList.toggle('active', tab === 'join');
  $('createFields').classList.toggle('hidden', tab !== 'create');
  $('joinFields').classList.toggle('hidden', tab !== 'join');
}

function setMode(mode) {
  state.mode = mode;
  $('ytMode').classList.toggle('active', mode === 'youtube');
  $('mp4Mode').classList.toggle('active', mode === 'mp4');
  $('videoUrl').placeholder = mode === 'youtube' ? 'Paste a YouTube link or video ID' : 'Paste a direct .mp4 link';
  $('urlError').classList.add('hidden');
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('theme-dark');
  try { localStorage.setItem('syncparty-theme', dark ? 'dark' : 'light'); } catch {}
  const button = $('themeToggle');
  button.innerHTML = '<i class="fa-solid ' + (dark ? 'fa-sun' : 'fa-moon') + '" aria-hidden="true"></i><span>' + (dark ? 'Light mode' : 'Dark / purple') + '</span>';
  button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark purple theme');
  button.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark purple theme');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#191326' : '#f7f8fc';
}

try { if (localStorage.getItem('syncparty-theme') === 'dark') toggleTheme(); } catch {}

function normalizeCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^PARTY-?/, '').replace(/-/g, '').slice(0, 10);
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'PARTY-' + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function validName() {
  const name = $('displayName').value.trim();
  if (!name) {
    toast('Add your name to continue.');
    $('displayName').focus();
    return null;
  }
  return name.slice(0, 24);
}

function getSupabaseClient() {
  const config = window.SYNCPARTY_CONFIG || {};
  if (!window.supabase?.createClient || !config.url || !config.publishableKey
    || /YOUR[-_]/i.test(config.url) || /YOUR[-_]/i.test(config.publishableKey)) return null;
  if (!state.client) state.client = window.supabase.createClient(config.url, config.publishableKey);
  return state.client;
}

function showRoom() {
  $('landing').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCodeDisplay').textContent = state.code;
  updateRoleUI();
  renderViewers();
  renderMediaParticipants();
  updateMediaControls();
  addSystem(state.role === 'host' ? 'You started the party.' : 'You joined the party.', true);
}

function updateRoleUI() {
  if (state.role === 'host') state.hostSessionId = state.sessionId;
  $('roleBadge').innerHTML = state.role === 'host'
    ? '<i class="fa-solid fa-crown mr-1"></i>Host'
    : '<i class="fa-solid fa-eye mr-1"></i>Viewer';
  $('hostControls').classList.toggle('hidden', state.role !== 'host');
  $('hostPlayback').classList.toggle('hidden', state.role !== 'host');
  $('guestBar').classList.toggle('hidden', state.role !== 'guest');
  $('resyncBtn').classList.toggle('hidden', state.role !== 'guest');
  const frame = $('playerFrame');
  if (frame) frame.classList.toggle('guest-view', state.role !== 'host');
  if (state.video?.mode === 'mp4' && state.player) state.player.controls = state.role === 'host';
  renderViewers();
  updateFullscreenButton();
}

function createRoom() {
  const name = validName();
  if (!name) return;
  if (!getSupabaseClient()) {
    toast('SyncParty is not connected yet. The project owner needs to finish the one-time setup.');
    return;
  }
  state.name = name;
  state.role = 'host';
  state.code = makeCode();
  state.bannedSessions = new Set();
  showRoom();
  connectToRoom();
}

function joinRoom() {
  const name = validName();
  if (!name) return;
  const code = normalizeCode($('roomCode').value);
  if (code.length !== 10) {
    toast('Enter the 10-character room code or open the invite link.');
    $('roomCode').focus();
    return;
  }
  if (!getSupabaseClient()) {
    toast('SyncParty is not connected yet. The project owner needs to finish the one-time setup.');
    return;
  }
  state.name = name;
  state.role = 'guest';
  state.code = 'PARTY-' + code;
  state.bannedSessions = new Set();
  showRoom();
  connectToRoom();
}

function connectToRoom() {
  if (!getSupabaseClient()) return;
  state.connected = false;
  if (state.role === 'guest') setGuestStatus(false, 'Connecting to room…');
  try {
    state.channel = state.client.channel('party:' + normalizeCode(state.code), {
      config: {
        private: false,
        broadcast: { self: false },
        presence: { key: state.sessionId },
      },
    });

    state.channel
      .on('broadcast', { event: 'playback' }, ({ payload }) => applyState(payload))
      .on('broadcast', { event: 'chat' }, ({ payload }) => renderChat(payload))
      .on('broadcast', { event: 'system' }, ({ payload }) => addSystem(payload.text, true))
      .on('broadcast', { event: 'moderation' }, ({ payload }) => handleModeration(payload))
      .on('broadcast', { event: 'host-transfer' }, ({ payload }) => handleHostTransfer(payload))
      .on('broadcast', { event: 'sync-request' }, () => {
        if (state.role === 'host' && state.lastState) broadcast('playback', state.lastState);
      })
      .on('broadcast', { event: 'end' }, () => {
        if (state.role === 'guest') {
          addSystem('The host ended the party.', true);
          setGuestStatus(false, 'The host ended the party');
        }
      })
      .on('presence', { event: 'sync' }, () => {
        renderViewers();
        updateGuestPresence();
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        if (state.role === 'host') newPresences.forEach(person => {
          if (person.sessionId === state.sessionId) return;
          if (state.bannedSessions.has(person.sessionId)) {
            broadcast('moderation', { action: 'ban', targetSessionId: person.sessionId, actorSessionId: state.sessionId });
          } else addSystem((person.name || 'A viewer') + ' joined the party.');
        });
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        leftPresences.forEach(person => {
          if (person.sessionId !== state.sessionId && person.role === 'host' && state.role === 'guest') {
            addSystem('The host left the room.', true);
            setGuestStatus(false, 'Host connection lost');
          } else if (person.sessionId !== state.sessionId && state.role === 'host') {
            addSystem((person.name || 'A viewer') + ' left the party.');
          }
        });
      })
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          state.connected = true;
          await trackPresence();
          updateMediaControls();
          if (state.role === 'guest') {
            updateGuestPresence();
            broadcast('sync-request', {});
          } else {
            toast('Room ready — share the invite link!');
            addSystem('Room is ready. Share the invite link to bring everyone in.');
            if (state.lastState) broadcast('playback', state.lastState);
            enforceRoomBans();
          }
          renderViewers();
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          state.connected = false;
          if (state.role === 'guest') setGuestStatus(false, 'Can’t connect right now');
          toast('Could not connect to the room. Check your internet and try again.');
        }
      });
  } catch (error) {
    state.connected = false;
    if (state.role === 'guest') setGuestStatus(false, 'Can’t connect right now');
    toast('Could not connect to the room. Try again.');
  }
}

function retryHostConnection() {
  if (!state.role) return;
  if (state.channel) state.client.removeChannel(state.channel);
  state.channel = null;
  connectToRoom();
}

function presenceList() {
  if (!state.channel) return [];
  const entries = Object.values(state.channel.presenceState()).flat();
  const unique = new Map();
  entries.forEach(person => {
    if (typeof person?.sessionId === 'string' && person.sessionId) {
      const name = typeof person.name === 'string' && person.name.trim() ? person.name.trim().slice(0, 24) : 'Viewer';
      unique.set(person.sessionId, {
        sessionId: person.sessionId,
        name,
        role: person.role,
      });
    }
  });
  return Array.from(unique.values());
}

function updateGuestPresence() {
  if (state.role !== 'guest' || !state.connected) return;
  const host = presenceList().find(person => person.role === 'host');
  if (host) state.hostSessionId = host.sessionId;
  const hostOnline = !!host;
  setGuestStatus(hostOnline, hostOnline ? 'Connected to host' : 'Waiting for the host…');
}

function renderViewers() {
  const viewers = presenceList();
  const el = $('viewerList');
  if (!el) return;
  el.replaceChildren();
  viewers.forEach(viewer => {
    const chip = document.createElement('div');
    chip.className = 'flex items-center gap-2 shrink-0 rounded-xl bg-[#fafafe] border border-[#f0f0f5] px-2.5 py-2';
    const avatar = document.createElement('span');
    avatar.className = 'avatar !w-7 !h-7 !rounded-[9px] !text-[11px]';
    avatar.textContent = viewer.name.trim().slice(0, 1).toUpperCase() || '?';
    const label = document.createElement('span');
    label.className = 'text-xs font-semibold text-[#62697c] max-w-[95px] truncate';
    label.textContent = viewer.name;
    const tag = document.createElement('span');
    tag.className = 'text-[9px] font-bold text-[#8179db]';
    tag.textContent = viewer.role === 'host' ? 'HOST' : '';
    chip.append(avatar, label, tag);
    if (state.role === 'host' && viewer.sessionId !== state.sessionId && viewer.role !== 'host') {
      const actions = document.createElement('select');
      actions.className = 'member-actions';
      actions.setAttribute('aria-label', 'Manage ' + viewer.name);
      actions.innerHTML = '<option value="">Manage</option><option value="remove">Remove</option><option value="ban">Ban</option><option value="transfer">Make host</option>';
      actions.addEventListener('change', () => {
        const action = actions.value;
        actions.value = '';
        if (action) moderateMember(viewer, action);
      });
      chip.append(actions);
    }
    el.append(chip);
  });
  $('viewerCount').textContent = viewers.length + ' here';
}

function enforceRoomBans() {
  if (state.role !== 'host') return;
  presenceList().forEach(viewer => {
    if (viewer.sessionId !== state.sessionId && state.bannedSessions.has(viewer.sessionId)) {
      broadcast('moderation', { action: 'ban', targetSessionId: viewer.sessionId, actorSessionId: state.sessionId });
    }
  });
}

async function moderateMember(viewer, action) {
  if (state.role !== 'host' || !viewer?.sessionId || viewer.sessionId === state.sessionId || viewer.role === 'host') return;
  const subject = viewer.name || 'this viewer';
  const verb = action === 'remove' ? 'Remove' : action === 'ban' ? 'Ban' : action === 'transfer' ? 'Transfer host to' : '';
  if (!verb || !window.confirm(verb + ' ' + subject + '?')) return;

  if (action === 'transfer') {
    const sent = await broadcast('host-transfer', {
      fromSessionId: state.sessionId,
      toSessionId: viewer.sessionId,
      toName: subject,
      bannedSessionIds: Array.from(state.bannedSessions),
    });
    if (!sent) return toast('Host transfer could not be sent. Try again.');
    state.role = 'guest';
    state.hostSessionId = null;
    updateRoleUI();
    await trackPresence();
    updateGuestPresence();
    toast('Host role transferred to ' + subject + '.');
    return;
  }

  if (action === 'ban') {
    state.bannedSessions.add(viewer.sessionId);
  }
  const sent = await broadcast('moderation', {
    action,
    targetSessionId: viewer.sessionId,
    actorSessionId: state.sessionId,
  });
  if (!sent) {
    if (action === 'ban') state.bannedSessions.delete(viewer.sessionId);
    return toast('Could not send the moderation action. Try again.');
  }
  addSystem(subject + (action === 'ban' ? ' was banned from this room.' : ' was removed from this room.'), true);
  toast(action === 'ban' ? subject + ' was banned.' : subject + ' was removed.');
}

function isCurrentHost(sessionId) {
  return presenceList().some(person => person.sessionId === sessionId && person.role === 'host');
}

function handleModeration(payload) {
  if (!payload || payload.targetSessionId !== state.sessionId || !isCurrentHost(payload.actorSessionId)) return;
  const notice = payload.action === 'ban'
    ? 'The host banned you from this room.'
    : payload.action === 'remove'
      ? 'The host removed you from this room.'
      : '';
  if (!notice) return;
  cleanup();
  backToLanding();
  toast(notice);
}

async function handleHostTransfer(payload) {
  if (!payload?.fromSessionId || payload.fromSessionId !== state.hostSessionId
    || payload.toSessionId !== state.sessionId || state.role !== 'guest') return;
  state.bannedSessions = new Set(Array.isArray(payload.bannedSessionIds)
    ? payload.bannedSessionIds.filter(id => typeof id === 'string').slice(0, 200)
    : []);
  state.role = 'host';
  updateRoleUI();
  await trackPresence();
  addSystem(state.name + ' is now the host.');
  if (state.lastState) broadcast('playback', state.lastState);
  toast('You are now the host.');
}

function setGuestStatus(ok, text) {
  const dot = $('guestConnectionDot');
  const label = $('guestConnectionText');
  const retry = $('retryConnection');
  if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (ok ? 'bg-emerald-400' : 'bg-amber-400');
  if (label) label.textContent = text;
  if (retry) retry.classList.toggle('hidden', ok || text === 'Connecting to room…' || text === 'Waiting for the host…');
}

async function broadcast(event, payload) {
  if (!state.channel || !state.connected) return false;
  try { return (await state.channel.send({ type: 'broadcast', event, payload })) === 'ok'; }
  catch { return false; }
}

async function trackPresence() {
  if (!state.channel || !state.connected) return false;
  try {
    const result = await state.channel.track({
      sessionId: state.sessionId,
      name: state.name,
      role: state.role,
    });
    return result === 'ok';
  } catch { return false; }
}

function hostedCallUrl(kind = 'audio') {
  const roomName = 'syncparty-' + normalizeCode(state.code).toLowerCase();
  const videoMuted = kind !== 'video';
  const displayName = encodeURIComponent('"' + state.name + '"');
  return 'https://' + HOSTED_CALL_DOMAIN + '/' + encodeURIComponent(roomName)
    + '#userInfo.displayName=' + displayName
    + '&config.prejoinConfig.enabled=false'
    + '&config.startWithAudioMuted=false&config.startWithVideoMuted=' + videoMuted;
}

function updateMediaControls() {
  const voiceJoin = $('voiceJoinButton');
  const cameraJoin = $('cameraJoinButton');
  const leaveButton = $('leaveMediaButton');
  const status = $('mediaStatus');
  if (!voiceJoin || !cameraJoin || !leaveButton) return;

  const callOpen = !!state.callWindow && !state.callWindow.closed;
  voiceJoin.disabled = !state.connected;
  cameraJoin.disabled = !state.connected;
  leaveButton.classList.toggle('hidden', !callOpen);
  leaveButton.disabled = !callOpen;

  const callLink = $('mediaCallLink');
  if (callOpen) {
    if (status) status.textContent = 'Call is open in its own window. Keep this tab open for the watch party.';
  } else if (status && callLink && !callLink.classList.contains('hidden')) {
    status.textContent = 'Your browser blocked the call window. Allow pop-ups or use the call link below.';
  } else if (status) {
    status.textContent = 'Your name is carried into the call. Your browser may ask for microphone or camera access.';
  }
}

function renderMediaParticipants() {
  const empty = $('mediaEmptyState');
  const callOpen = !!state.callWindow && !state.callWindow.closed;
  if (empty) empty.textContent = callOpen
    ? 'Your watch party stays in this tab while the call runs in its own window.'
    : 'On desktop, the call opens in a compact window beside your watch party.';
  updateMediaControls();
}

function clearCallLink() {
  const link = $('mediaCallLink');
  if (!link) return;
  link.classList.add('hidden');
  link.removeAttribute('href');
}

function showCallLink(url) {
  const link = $('mediaCallLink');
  if (!link) return;
  link.href = url;
  link.classList.remove('hidden');
}

function joinMedia(kind) {
  if (!['audio', 'video'].includes(kind)) return;
  if (!state.connected || !state.channel) return toast('Wait until the room connects before joining voice or video.');

  const url = hostedCallUrl(kind);
  const link = $('mediaCallLink');
  if (link) link.href = url;

  if (state.callWindow && !state.callWindow.closed) {
    try { state.callWindow.focus(); } catch {}
    updateMediaControls();
    toast('Your call is already open. Use its controls to turn your camera or microphone on or off.');
    return;
  }

  let callWindow = null;
  const screenLeft = window.screenX ?? window.screenLeft ?? 0;
  const screenTop = window.screenY ?? window.screenTop ?? 0;
  const availableWidth = window.screen?.availWidth || window.outerWidth || 1100;
  const availableHeight = window.screen?.availHeight || window.outerHeight || 800;
  const width = Math.min(1100, Math.max(360, availableWidth - 40));
  const height = Math.min(820, Math.max(520, availableHeight - 60));
  const left = Math.max(0, Math.round(screenLeft + ((window.outerWidth || width) - width) / 2));
  const top = Math.max(0, Math.round(screenTop + ((window.outerHeight || height) - height) / 2));
  const popupFeatures = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  try { callWindow = window.open(url, 'syncparty-call', popupFeatures); } catch {}
  if (callWindow) {
    try { callWindow.opener = null; } catch {}
    state.callWindow = callWindow;
    clearCallLink();
    toast(kind === 'audio' ? 'Voice call opened in a separate window.' : 'Camera call opened in a separate window.');
  } else {
    showCallLink(url);
    toast('Your browser blocked the call window. Allow pop-ups or use the call link below.');
  }
  updateMediaControls();
}

function openHostedCallFromLink(event) {
  if (state.callWindow && !state.callWindow.closed) {
    try { state.callWindow.focus(); } catch {}
    event.preventDefault();
    return false;
  }
  return true;
}

function leaveMedia() {
  if (state.callWindow && !state.callWindow.closed) {
    try { state.callWindow.close(); } catch {}
  }
  state.callWindow = null;
  clearCallLink();
  updateMediaControls();
}
function addSystem(text, localOnly = false) {
  const stickToBottom = messagesNearBottom();
  const item = document.createElement('div');
  item.className = 'text-center text-[11px] text-[#9a9eac] py-1';
  item.textContent = text;
  $('messages').append(item);
  scrollMessages(stickToBottom);
  if (!localOnly && state.role === 'host') broadcast('system', { text });
}

function renderChat(message) {
  if (!message?.id || state.chatSeen.has(message.id)) return;
  state.chatSeen.add(message.id);
  if (state.chatSeen.size > 300) state.chatSeen.delete(state.chatSeen.values().next().value);
  const mine = message.sessionId === state.sessionId;
  const stickToBottom = messagesNearBottom();
  const row = document.createElement('div');
  row.className = 'flex ' + (mine ? 'justify-end' : 'justify-start');
  const box = document.createElement('div');
  box.className = 'msg ' + (mine ? 'mine' : '');
  const meta = document.createElement('div');
  meta.className = 'text-[10px] font-bold text-[#7167e8] mb-1';
  meta.textContent = (mine ? 'You' : message.name || 'Viewer') + ' · ' + new Date(message.time || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const body = document.createElement('div');
  body.textContent = String(message.text || '').slice(0, 500);
  box.append(meta, body);
  row.append(box);
  $('messages').append(row);
  scrollMessages(stickToBottom);
  if (!mine && Array.isArray(message.mentionSessionIds) && message.mentionSessionIds.includes(state.sessionId)) {
    notifyMention(message);
  }
}

function messagesNearBottom() {
  const messages = $('messages');
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
}

function scrollMessages(force = false) {
  if (force) $('messages').scrollTop = $('messages').scrollHeight;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsInMessage(text) {
  let remaining = text;
  const mentioned = [];
  const candidates = presenceList()
    .filter(person => person.sessionId !== state.sessionId && person.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  candidates.forEach(person => {
    const pattern = '(^|[\\s(])@' + escapeRegExp(person.name.trim()) + '(?=$|[\\s.,!?;:)])';
    if (!new RegExp(pattern, 'i').test(remaining)) return;
    mentioned.push(person.sessionId);
    remaining = remaining.replace(new RegExp(pattern, 'gi'), '$1@');
  });
  return mentioned;
}

function notifyMention(message) {
  const sender = message.name || 'Someone';
  const presentationActive = document.hidden || document.fullscreenElement || document.webkitFullscreenElement;
  if (!presentationActive) {
    toast(sender + ' mentioned you in chat.');
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Mention in SyncParty', { body: sender + ': ' + String(message.text || '').slice(0, 120) }); return; } catch {}
  }
  if (state.pendingMentions.length < 50) state.pendingMentions.push(sender);
}

function showPendingMentions() {
  if (document.hidden || document.fullscreenElement || document.webkitFullscreenElement || !state.pendingMentions.length) return;
  const senders = Array.from(new Set(state.pendingMentions.splice(0)));
  toast((senders.length === 1 ? senders[0] : senders.join(', ')) + ' mentioned you in chat.');
}

function updateMentionSuggestions() {
  const input = $('chatInput');
  const popup = $('mentionSuggestions');
  const beforeCursor = input.value.slice(0, input.selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) {
    state.mentionCandidates = [];
    popup.classList.add('hidden');
    popup.replaceChildren();
    return;
  }
  const prefix = match[2].toLocaleLowerCase();
  const candidates = presenceList().filter(person => person.sessionId !== state.sessionId
    && person.name.toLocaleLowerCase().startsWith(prefix));
  state.mentionCandidates = candidates;
  state.mentionIndex = 0;
  popup.replaceChildren();
  candidates.forEach((person, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'mention-option' + (index === 0 ? ' active' : '');
    option.setAttribute('role', 'option');
    option.textContent = '@' + person.name;
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => insertMention(person.name));
    popup.append(option);
  });
  popup.classList.toggle('hidden', candidates.length === 0);
}

function insertMention(name) {
  const input = $('chatInput');
  const beforeCursor = input.value.slice(0, input.selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return false;
  const start = beforeCursor.length - match[0].length + match[1].length;
  input.setRangeText('@' + name + ' ', start, input.selectionStart, 'end');
  $('mentionSuggestions').classList.add('hidden');
  input.focus();
  updateMentionSuggestions();
  return true;
}

function moveMentionSelection(direction) {
  const popup = $('mentionSuggestions');
  if (popup.classList.contains('hidden') || !state.mentionCandidates.length) return false;
  state.mentionIndex = (state.mentionIndex + direction + state.mentionCandidates.length) % state.mentionCandidates.length;
  popup.querySelectorAll('.mention-option').forEach((option, index) => {
    option.classList.toggle('active', index === state.mentionIndex);
  });
  return true;
}

function acceptMentionSelection() {
  const person = state.mentionCandidates[state.mentionIndex];
  if (!person) return false;
  return insertMention(person.name);
}

function sendChat(event) {
  event.preventDefault();
  const text = $('chatInput').value.trim().slice(0, 500);
  if (!text) return;
  if (!state.connected) return toast('Wait for the room to connect before chatting.');
  const message = {
    id: crypto.randomUUID(),
    sessionId: state.sessionId,
    name: state.name,
    text,
    time: Date.now(),
    mentionSessionIds: mentionsInMessage(text),
  };
  renderChat(message);
  broadcast('chat', message);
  $('chatInput').value = '';
  updateMentionSuggestions();
}

async function copyText(value, successText) {
  try {
    await navigator.clipboard.writeText(value);
    toast(successText);
  } catch {
    window.prompt('Copy this:', value);
  }
}

function copyRoom() { copyText(state.code, 'Room code copied!'); }

function inviteUrl() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.code);
  return url.toString();
}

function copyInvite() { copyText(inviteUrl(), 'Invite link copied!'); }

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.textContent = ''; }, 3500);
}

function parseYouTube(raw) {
  const value = raw.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  let url;
  try { url = new URL(value.includes('://') ? value : 'https://' + value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return null;
  let id = '';
  if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
  else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] || '';
  return /^[\w-]{11}$/.test(id) ? id : null;
}

function loadVideo() {
  const raw = $('videoUrl').value.trim();
  let video;
  if (state.mode === 'youtube') {
    const id = parseYouTube(raw);
    if (!id) return showUrlError('Paste a YouTube link or an 11-character video ID.');
    video = { mode: 'youtube', id };
  } else {
    let url;
    try { url = new URL(raw); } catch { return showUrlError('Paste a complete MP4 link starting with http:// or https://.'); }
    if (!/^https?:$/.test(url.protocol)) return showUrlError('MP4 links must start with http:// or https://.');
    video = { mode: 'mp4', url: url.href };
  }
  $('urlError').classList.add('hidden');
  state.video = video;
  state.lastState = { video, playing: false, time: 0, at: Date.now() };
  mountVideo(video);
  sendState(state.lastState);
  setPlayStatus('Ready to play');
}

function showUrlError(message) {
  $('urlError').textContent = message;
  $('urlError').classList.remove('hidden');
}

function updateFullscreenButton() {
  const button = $('fullscreenToggle');
  const frame = $('playerFrame');
  if (!button || !frame) return;
  const activeElement = document.fullscreenElement || document.webkitFullscreenElement;
  const isFullscreen = !!activeElement && (activeElement === frame || frame.contains(activeElement))
    || !!state.player?.webkitDisplayingFullscreen;
  button.disabled = !state.video && !isFullscreen;
  button.innerHTML = '<i class="fa-solid ' + (isFullscreen ? 'fa-compress' : 'fa-expand') + '" aria-hidden="true"></i><span>' + (isFullscreen ? 'Minimise' : 'Full screen') + '</span>';
  button.setAttribute('aria-label', isFullscreen ? 'Exit full screen and minimise video' : 'Make video full screen');
  button.setAttribute('title', isFullscreen ? 'Minimise video' : 'Full screen');
}

async function toggleFullscreen() {
  const frame = $('playerFrame');
  const activeElement = document.fullscreenElement || document.webkitFullscreenElement;
  const isFullscreen = !!activeElement && (activeElement === frame || frame.contains(activeElement))
    || !!state.player?.webkitDisplayingFullscreen;
  try {
    if (isFullscreen) {
      if (state.player?.webkitDisplayingFullscreen && state.player.webkitExitFullscreen) state.player.webkitExitFullscreen();
      else if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (frame.requestFullscreen) await frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
    else if (state.video?.mode === 'mp4' && state.player?.webkitEnterFullscreen) state.player.webkitEnterFullscreen();
    else toast('Full screen is not supported by this browser.');
  } catch { toast('Could not change full screen mode. Try the video player controls.'); }
  updateFullscreenButton();
}

function mountVideo(video) {
  state.ready = false;
  state.suppress = true;
  const generation = ++state.playerGeneration;
  if (state.player?.destroy) {
    try { state.player.destroy(); } catch {}
  } else if (state.player?.tagName === 'VIDEO') {
    try { state.player.pause(); state.player.removeAttribute('src'); state.player.load(); } catch {}
  }
  state.player = null;
  const frame = $('playerFrame');
  const fullscreenButton = $('fullscreenToggle');
  frame.replaceChildren();
  if (fullscreenButton) frame.append(fullscreenButton);
  if (video.mode === 'mp4') {
    const player = document.createElement('video');
    player.controls = state.role === 'host';
    player.playsInline = true;
    player.preload = 'metadata';
    player.src = video.url;
    player.addEventListener('webkitbeginfullscreen', updateFullscreenButton);
    player.addEventListener('webkitendfullscreen', updateFullscreenButton);
    player.addEventListener('loadedmetadata', () => {
      state.ready = true;
      state.suppress = false;
      syncPlayButton();
      if (state.role === 'guest' && state.lastState) applyState(state.lastState);
    });
    player.addEventListener('play', () => { if (!state.suppress && state.role === 'host') publishPlayerState(true); });
    player.addEventListener('pause', () => { if (!state.suppress && state.role === 'host' && !player.ended) publishPlayerState(false); });
    player.addEventListener('seeked', () => { if (!state.suppress && state.role === 'host') publishPlayerState(!player.paused); });
    player.addEventListener('error', () => {
      setPlayStatus('Video could not be loaded');
      toast('This MP4 link is unavailable to one or more viewers. Try a public video link.');
    });
    frame.append(player);
    if (fullscreenButton) frame.append(fullscreenButton);
    state.player = player;
    updateFullscreenButton();
    return;
  }
  const box = document.createElement('div');
  box.id = 'ytPlayer';
  box.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  frame.append(box);
  if (fullscreenButton) frame.append(fullscreenButton);
  updateFullscreenButton();
  loadYouTubeApi().then(() => {
    if (generation !== state.playerGeneration) return;
    state.player = new YT.Player('ytPlayer', {
      videoId: video.id,
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 0, controls: state.role === 'host' ? 1 : 0, disablekb: state.role === 'host' ? 0 : 1, fs: 1, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          state.ready = true;
          state.suppress = false;
          syncPlayButton();
          if (state.role === 'guest' && state.lastState) applyState(state.lastState);
        },
        onStateChange: event => {
          if (state.role !== 'host' || state.suppress) return;
          if (event.data === YT.PlayerState.PLAYING) publishPlayerState(true);
          if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) publishPlayerState(false);
        },
        onError: event => {
          setPlayStatus('Video could not be played');
          if ([101, 150].includes(event?.data)) toast('This video owner does not allow embedded playback.');
          else if (event?.data === 100) toast('This video is private, removed, or unavailable.');
          else toast('YouTube could not play this video.');
        },
      },
    });
  }).catch(() => {
    if (generation === state.playerGeneration) toast('The YouTube player could not load. Check your internet connection.');
  });
}

let ytPromise;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = reject;
    document.head.append(script);
    setTimeout(() => reject(new Error('YouTube API timed out')), 12000);
  });
  return ytPromise;
}

function playerTime() {
  try {
    if (state.video?.mode === 'mp4') return state.player?.currentTime || 0;
    if (state.player?.getCurrentTime) return state.player.getCurrentTime();
  } catch {}
  return 0;
}

function isPlaying() {
  try {
    if (state.video?.mode === 'mp4') return !!state.player && !state.player.paused;
    return !!state.player?.getPlayerState && state.player.getPlayerState() === YT.PlayerState.PLAYING;
  } catch { return false; }
}

function publishPlayerState(playing) {
  state.lastState = { video: state.video, playing, time: playerTime(), at: Date.now() };
  sendState(state.lastState);
  setPlayStatus(playing ? 'Playing' : 'Paused');
}

function sendState(playbackState) {
  if (state.role === 'host') broadcast('playback', playbackState);
}

function applyState(playbackState) {
  if (!playbackState) return;
  if (playbackState.video && JSON.stringify(playbackState.video) !== JSON.stringify(state.video)) {
    state.video = playbackState.video;
    mountVideo(playbackState.video);
  }
  state.lastState = playbackState;
  if (!playbackState.video) return;
  const target = Math.max(0, Number(playbackState.time) || 0)
    + (playbackState.playing ? Math.max(0, Date.now() - (playbackState.at || Date.now())) / 1000 : 0);
  const sync = () => {
    if (!state.ready || !state.player) return;
    try {
      if (Math.abs(playerTime() - target) > 1.5) {
        if (state.video.mode === 'mp4') state.player.currentTime = target;
        else state.player.seekTo(target, true);
      }
      state.suppress = true;
      if (state.video.mode === 'mp4') {
        if (playbackState.playing) state.player.play().catch(() => setPlayStatus('Tap play to start in sync'));
        else state.player.pause();
      } else if (playbackState.playing) state.player.playVideo();
      else state.player.pauseVideo();
      setTimeout(() => { state.suppress = false; }, 500);
      setPlayStatus(playbackState.playing ? 'Playing' : 'Paused');
    } catch {}
  };
  if (state.ready) sync();
  else setTimeout(() => { if (state.lastState === playbackState) sync(); }, 750);
}

function togglePlayback() {
  if (state.role !== 'host' || !state.player) return;
  if (state.video.mode === 'mp4') {
    if (state.player.paused) state.player.play().catch(() => toast('Tap play again to start the video.'));
    else state.player.pause();
  } else if (isPlaying()) state.player.pauseVideo();
  else state.player.playVideo();
}

function seekBy(delta) {
  if (state.role !== 'host' || !state.player) return;
  const time = Math.max(0, playerTime() + delta);
  if (state.video.mode === 'mp4') state.player.currentTime = time;
  else state.player.seekTo(time, true);
  setTimeout(() => publishPlayerState(isPlaying()), 150);
}

function syncPlayButton() {
  const button = $('playPauseBtn');
  if (button) button.innerHTML = isPlaying() ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
}

function setPlayStatus(text) {
  $('playStatus').textContent = text;
  syncPlayButton();
}

function requestSync() {
  broadcast('sync-request', {});
  if (state.lastState) applyState(state.lastState);
  toast('Syncing with the host…');
}

function cleanup() {
  state.playerGeneration += 1;
  if (state.callWindow && !state.callWindow.closed) {
    try { state.callWindow.close(); } catch {}
  }
  state.callWindow = null;
  clearCallLink();
  const frame = $('playerFrame');
  const activeElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (state.player?.webkitDisplayingFullscreen && state.player.webkitExitFullscreen) {
    try { state.player.webkitExitFullscreen(); } catch {}
  } else if (activeElement && frame?.contains(activeElement)) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  if (state.channel && state.client) state.client.removeChannel(state.channel);
  state.channel = null;
  state.connected = false;
  state.player = null;
  state.video = null;
  state.lastState = null;
  state.ready = false;
  state.chatSeen.clear();
  updateMediaControls();
  updateFullscreenButton();
}
async function leaveRoom() {
  if (state.role === 'host') await broadcast('end', {});
  cleanup();
  backToLanding();
}

function backToLanding() {
  $('room').classList.add('hidden');
  $('landing').classList.remove('hidden');
  history.replaceState({}, '', location.pathname + location.hash);
  state.role = null;
  state.code = '';
  $('messages').replaceChildren();
  $('playerFrame').innerHTML = '<div class="placeholder"><div class="w-[58px] h-[58px] rounded-2xl bg-white/10 grid place-items-center mx-auto mb-3 text-white"><i class="fa-solid fa-play ml-1"></i></div><div class="font-semibold text-sm text-white">Your watch party starts here</div><div class="text-xs text-[#a9adba] mt-1">The host can load a video anytime</div></div><button id="fullscreenToggle" class="fullscreen-toggle" type="button" onclick="toggleFullscreen()" aria-label="Enter full screen" title="Enter full screen" disabled><i class="fa-solid fa-expand" aria-hidden="true"></i><span>Full screen</span></button>';
  updateFullscreenButton();
}

$('roomCode').addEventListener('input', event => {
  const code = normalizeCode(event.target.value);
  event.target.value = code ? 'PARTY-' + code : '';
});
$('roomCode').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
$('videoUrl').addEventListener('keydown', event => { if (event.key === 'Enter') loadVideo(); });
$('chatInput').addEventListener('input', updateMentionSuggestions);
$('chatInput').addEventListener('keydown', event => {
  const popupOpen = !$('mentionSuggestions').classList.contains('hidden');
  if (popupOpen && event.key === 'ArrowDown') {
    event.preventDefault();
    moveMentionSelection(1);
  } else if (popupOpen && event.key === 'ArrowUp') {
    event.preventDefault();
    moveMentionSelection(-1);
  } else if (popupOpen && event.key === 'Enter' && acceptMentionSelection()) {
    event.preventDefault();
  } else if (event.key === 'Escape') {
    $('mentionSuggestions').classList.add('hidden');
  }
});
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
document.addEventListener('visibilitychange', () => {
  showPendingMentions();
});
document.addEventListener('fullscreenchange', showPendingMentions);
document.addEventListener('webkitfullscreenchange', showPendingMentions);

const inviteCode = new URLSearchParams(location.search).get('room');
if (inviteCode) {
  setTab('join');
  $('roomCode').value = 'PARTY-' + normalizeCode(inviteCode);
}
