'use strict';

const $ = id => document.getElementById(id);
const state = {
  role: null,
  code: '',
  name: '',
  sessionId: crypto.randomUUID(),
  client: null,
  channel: null,
  connected: false,
  mode: 'youtube',
  video: null,
  player: null,
  ready: false,
  suppress: false,
  lastState: null,
  chatSeen: new Set(),
  bannedSessions: new Set(),
  mentionCandidates: [],
  mentionIndex: 0,
  toastTimer: null,
};

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function setTab(tab) {
  $('createTab').classList.toggle('active', tab === 'create');
  $('joinTab').classList.toggle('active', tab === 'join');
  $('createFields').classList.toggle('hidden', tab !== 'create');
  $('joinFields').classList.toggle('hidden', tab !== 'join');
}

function setMode(mode) {
  state.mode = mode;
  $('ytMode').classList.toggle('active', mode === 'youtube');
  $('mp4Mode').classList.toggle('active', mode === 'video');
  $('videoUrl').placeholder = mode === 'youtube' ? 'Paste a YouTube link or video ID' : 'Paste a direct MP4, WebM, or other browser-playable video URL';
  $('urlError').classList.add('hidden');
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('theme-dark');
  try { localStorage.setItem('syncparty-theme', dark ? 'dark' : 'light'); } catch {}
  const icon = dark ? 'fa-sun' : 'fa-moon';
  $('themeToggle').innerHTML = '<i class="fa-solid ' + icon + '" aria-hidden="true"></i>';
  $('themeToggle').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  $('themeToggleRoom').innerHTML = '<i class="fa-solid ' + icon + '" aria-hidden="true"></i> <span class="theme-label">' + (dark ? 'Light mode' : 'Dark mode') + '</span>';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#181a26' : '#f7f8fc';
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
  $('roleBadge').innerHTML = state.role === 'host'
    ? '<i class="fa-solid fa-crown" aria-hidden="true"></i> Host'
    : '<i class="fa-solid fa-eye" aria-hidden="true"></i> Viewer';
  $('hostControls').classList.toggle('hidden', state.role !== 'host');
  $('hostPlayback').classList.toggle('hidden', state.role !== 'host');
  $('guestBar').classList.toggle('hidden', state.role !== 'guest');
  $('resyncBtn').classList.toggle('hidden', state.role !== 'guest');
  renderViewers();
  if (state.video) mountVideo(state.video);
  addSystem(state.role === 'host' ? 'You started the party.' : 'You joined the party.', true);
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
      .on('broadcast', { event: 'sync-request' }, () => {
        if (state.role === 'host' && state.lastState) broadcast('playback', state.lastState);
      })
      .on('broadcast', { event: 'end' }, () => {
        if (state.role === 'guest') {
          addSystem('The host ended the party.', true);
          setGuestStatus(false, 'The host ended the party');
        }
      })
      .on('broadcast', { event: 'moderation' }, ({ payload }) => handleModeration(payload))
      .on('presence', { event: 'sync' }, () => {
        renderViewers();
        updateGuestPresence();
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        if (state.role === 'host') newPresences.forEach(person => {
          if (state.bannedSessions.has(person.sessionId)) broadcast('moderation', { target: person.sessionId, action: 'ban' });
          else if (person.sessionId !== state.sessionId) addSystem((person.name || 'A viewer') + ' joined the party.');
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
          await state.channel.track({ sessionId: state.sessionId, name: state.name, role: state.role });
          if (state.role === 'guest') {
            updateGuestPresence();
            broadcast('sync-request', {});
          } else {
            toast('Room ready — share the invite link!');
            addSystem('Room is ready. Share the invite link to bring everyone in.');
            if (state.lastState) broadcast('playback', state.lastState);
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
    if (person?.sessionId) unique.set(person.sessionId, { sessionId: person.sessionId, name: person.name || 'Viewer', role: person.role });
  });
  return Array.from(unique.values());
}

function updateGuestPresence() {
  if (state.role !== 'guest' || !state.connected) return;
  const hostOnline = presenceList().some(person => person.role === 'host');
  setGuestStatus(hostOnline, hostOnline ? 'Connected to host' : 'Waiting for the host…');
}

function renderViewers() {
  const viewers = presenceList();
  const el = $('viewerList');
  if (!el) return;
  el.replaceChildren();
  viewers.forEach(viewer => {
    const chip = document.createElement('div');
    chip.className = 'viewer-chip';
    const avatar = document.createElement('span');
    avatar.className = 'viewer-avatar';
    avatar.textContent = viewer.name.trim().slice(0, 1).toUpperCase() || '?';
    const label = document.createElement('span');
    label.className = 'viewer-name';
    label.textContent = viewer.name;
    const tag = document.createElement('span');
    tag.className = 'viewer-role';
    tag.textContent = viewer.role === 'host' ? 'HOST' : '';
    chip.append(avatar, label, tag);
    if (state.role === 'host' && viewer.role !== 'host') {
      const actions = document.createElement('div');
      actions.className = 'viewer-actions';
      [['transfer', 'fa-crown', 'Transfer host'], ['kick', 'fa-user-xmark', 'Remove viewer'], ['ban', 'fa-ban', 'Ban viewer']].forEach(([action, icon, title]) => {
        const button = document.createElement('button');
        button.className = 'viewer-action';
        button.title = title;
        button.setAttribute('aria-label', title + ' ' + viewer.name);
        button.innerHTML = '<i class="fa-solid ' + icon + '"></i>';
        button.onclick = () => moderateViewer(viewer.sessionId, action, viewer.name);
        actions.append(button);
      });
      chip.append(actions);
    }
    el.append(chip);
  });
  $('viewerCount').textContent = viewers.length + ' here';
}

function updateRoleUi() {
  $('roleBadge').innerHTML = state.role === 'host'
    ? '<i class="fa-solid fa-crown" aria-hidden="true"></i> Host'
    : '<i class="fa-solid fa-eye" aria-hidden="true"></i> Viewer';
  $('hostControls').classList.toggle('hidden', state.role !== 'host');
  $('hostPlayback').classList.toggle('hidden', state.role !== 'host');
  $('guestBar').classList.toggle('hidden', state.role !== 'guest');
  $('resyncBtn').classList.toggle('hidden', state.role !== 'guest');
  renderViewers();
  if (state.video) mountVideo(state.video);
}

async function moderateViewer(sessionId, action, name) {
  if (state.role !== 'host' || !sessionId || !['transfer', 'kick', 'ban'].includes(action)) return;
  if (!await broadcast('moderation', { target: sessionId, action })) return toast('Could not send the room action. Check your connection.');
  if (action === 'transfer') {
    addSystem('Host role transferred to ' + name + '.');
    state.role = 'guest';
    await state.channel.track({ sessionId: state.sessionId, name: state.name, role: state.role });
    updateRoleUi();
  } else {
    if (action === 'ban') state.bannedSessions.add(sessionId);
    addSystem(name + (action === 'ban' ? ' was banned from this room.' : ' was removed from the room.'));
  }
}

async function handleModeration(payload) {
  if (!payload || payload.target !== state.sessionId) return;
  if (payload.action === 'transfer') {
    state.role = 'host';
    await state.channel?.track({ sessionId: state.sessionId, name: state.name, role: state.role });
    updateRoleUi();
    addSystem('You are now the host.', true);
    toast('You are now the host.');
  } else if (payload.action === 'kick' || payload.action === 'ban') {
    addSystem(payload.action === 'ban' ? 'The host banned you from this room.' : 'The host removed you from this room.', true);
    toast(payload.action === 'ban' ? 'You were banned from this room.' : 'You were removed from this room.');
    setTimeout(() => { cleanup(); backToLanding(); }, 900);
  }
}

function setGuestStatus(ok, text) {
  const dot = $('guestConnectionDot');
  const label = $('guestConnectionText');
  const retry = $('retryConnection');
  if (dot) dot.className = 'guest-dot' + (ok ? ' connected' : '');
  if (label) label.textContent = text;
  if (retry) retry.classList.toggle('hidden', ok || text === 'Connecting to room…' || text === 'Waiting for the host…');
}

function broadcast(event, payload) {
  if (!state.channel || !state.connected) return Promise.resolve(false);
  return state.channel.send({ type: 'broadcast', event, payload }).then(status => status === 'ok');
}

function addSystem(text, localOnly = false) {
  const wasAtBottom = messagesAtBottom();
  const item = document.createElement('div');
  item.className = 'system-message';
  item.textContent = text;
  $('messages').append(item);
  if (wasAtBottom) scrollMessages(true);
  if (!localOnly && state.role === 'host') broadcast('system', { text });
}

function renderChat(message) {
  if (!message?.id || state.chatSeen.has(message.id)) return;
  state.chatSeen.add(message.id);
  if (state.chatSeen.size > 300) state.chatSeen.delete(state.chatSeen.values().next().value);
  const mine = message.sessionId === state.sessionId;
  const row = document.createElement('div');
  row.className = 'message-row' + (mine ? ' mine' : '');
  const box = document.createElement('div');
  box.className = 'message-bubble';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = (mine ? 'You' : message.name || 'Viewer') + ' · ' + new Date(message.time || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const body = document.createElement('div');
  body.textContent = String(message.text || '').slice(0, 500);
  box.append(meta, body);
  const wasAtBottom = messagesAtBottom();
  row.append(box);
  $('messages').append(row);
  if (mine || wasAtBottom) scrollMessages(true);
  const chatText = String(message.text || '').toLowerCase();
  if (!mine && chatText.includes('@' + state.name.toLowerCase())) notifyMention(message);
}

function notifyMention(message) {
  let notice = $('mentionNotice');
  if (!notice) {
    notice = document.createElement('button');
    notice.id = 'mentionNotice';
    notice.className = 'mention-notice';
    notice.onclick = () => { $('chatInput').focus(); notice.remove(); };
    document.body.append(notice);
  }
  notice.textContent = (message.name || 'Someone') + ' mentioned you in chat: ' + String(message.text).slice(0, 100);
  clearTimeout(state.mentionTimer);
  state.mentionTimer = setTimeout(() => notice.remove(), 6000);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('SyncParty mention', { body: (message.name || 'Someone') + ' mentioned you in chat.' });
  }
}

function messagesAtBottom() {
  const messages = $('messages');
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
}

function scrollMessages(force = false) {
  if (force || messagesAtBottom()) $('messages').scrollTop = $('messages').scrollHeight;
}

function sendChat(event) {
  event.preventDefault();
  const text = $('chatInput').value.trim().slice(0, 500);
  if (!text) return;
  if (!state.connected) return toast('Wait for the room to connect before chatting.');
  const message = { id: crypto.randomUUID(), sessionId: state.sessionId, name: state.name, text, time: Date.now() };
  renderChat(message);
  broadcast('chat', message);
  $('chatInput').value = '';
  hideMentionSuggestions();
}

function hideMentionSuggestions() {
  $('mentionSuggestions').classList.add('hidden');
  $('mentionSuggestions').replaceChildren();
  state.mentionCandidates = [];
  state.mentionIndex = 0;
}

function showMentionSuggestions() {
  const input = $('chatInput');
  const match = input.value.match(/(^|\s)@([\w .-]*)$/u);
  if (!match) return hideMentionSuggestions();
  const query = match[2].trim().toLowerCase();
  const candidates = presenceList().filter(person => person.sessionId !== state.sessionId
    && person.name.toLowerCase().startsWith(query));
  state.mentionCandidates = candidates.slice(0, 8);
  state.mentionIndex = 0;
  const list = $('mentionSuggestions');
  list.replaceChildren();
  if (!state.mentionCandidates.length) return list.classList.add('hidden');
  state.mentionCandidates.forEach((person, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'mention-option';
    option.setAttribute('role', 'option');
    option.innerHTML = '<span class="viewer-avatar">' + escapeHtml(person.name.slice(0, 1).toUpperCase()) + '</span>'
      + '<span>' + escapeHtml(person.name) + (person.role === 'host' ? ' · Host' : '') + '</span>';
    option.addEventListener('pointerdown', event => event.preventDefault());
    option.addEventListener('click', () => insertMention(index));
    list.append(option);
  });
  list.classList.remove('hidden');
}

function handleMentionKey(event) {
  if ($('mentionSuggestions').classList.contains('hidden')) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.mentionIndex = (state.mentionIndex + direction + state.mentionCandidates.length) % state.mentionCandidates.length;
    $('mentionSuggestions').querySelectorAll('.mention-option').forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === state.mentionIndex));
    });
  } else if (event.key === 'Enter' && state.mentionCandidates.length) {
    event.preventDefault();
    insertMention(state.mentionIndex);
  } else if (event.key === 'Escape') hideMentionSuggestions();
}

function insertMention(index) {
  const person = state.mentionCandidates[index];
  if (!person) return;
  const input = $('chatInput');
  input.value = input.value.replace(/(^|\s)@[\w .-]*$/u, (_, prefix) => prefix + '@' + person.name + ' ');
  hideMentionSuggestions();
  input.focus();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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
    try { url = new URL(raw); } catch { return showUrlError('Paste a direct video file URL starting with http:// or https://.'); }
    if (!/^https?:$/.test(url.protocol)) return showUrlError('Video links must start with http:// or https://.');
    video = { mode: 'video', url: url.href };
  }
  $('urlError').classList.add('hidden');
  state.video = video;
  state.lastState = { video, playing: false, time: 0, at: Date.now() };
  mountVideo(video);
  sendState(state.lastState);
  setPlayStatus('Ready to play');
}

async function uploadVideoFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('video/')) return showUrlError('Choose a video file.');
  if (file.size > 500 * 1024 * 1024) return showUrlError('Choose a video smaller than 500 MB.');
  const config = window.SYNCPARTY_CONFIG || {};
  const bucket = config.storageBucket || 'syncparty-videos';
  if (!state.client?.storage) return showUrlError('Supabase Storage is unavailable. Check the Supabase connection.');
  $('uploadStatus').textContent = 'Uploading ' + file.name + '…';
  $('uploadStatus').classList.remove('hidden');
  $('urlError').classList.add('hidden');
  try {
    const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-100) || 'video';
    const path = normalizeCode(state.code) + '/' + crypto.randomUUID() + '-' + safeName;
    const { error } = await state.client.storage.from(bucket).upload(path, file, {
      contentType: file.type,
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw error;
    const { data } = state.client.storage.from(bucket).getPublicUrl(path);
    $('videoUrl').value = data.publicUrl;
    setMode('video');
    loadVideo();
    $('uploadStatus').textContent = 'Upload complete. Your video is ready for the room.';
  } catch (error) {
    $('uploadStatus').classList.add('hidden');
    showUrlError(error?.message?.includes('Bucket not found')
      ? 'Storage bucket not found. Create the public bucket "' + bucket + '" and enable room uploads as described in README.md.'
      : 'Upload failed. Check the Storage bucket upload policy and try again.');
  }
}

function toggleFullscreen() {
  const frame = $('playerFrame');
  if (document.fullscreenElement || document.webkitFullscreenElement || state.player?.webkitDisplayingFullscreen) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => toast('Could not leave fullscreen.'));
    else if (state.player?.webkitExitFullscreen) state.player.webkitExitFullscreen();
    return;
  }
  const youtubeFrame = state.video?.mode === 'youtube' ? state.player?.getIframe?.() : null;
  const request = frame.requestFullscreen || frame.webkitRequestFullscreen
    || youtubeFrame?.requestFullscreen || youtubeFrame?.webkitRequestFullscreen;
  if (request) {
    const target = frame.requestFullscreen || frame.webkitRequestFullscreen ? frame : youtubeFrame;
    Promise.resolve(request.call(target)).catch(() => toast('Fullscreen is not available in this browser.'));
    return;
  }
  if (state.player?.webkitEnterFullscreen) return state.player.webkitEnterFullscreen();
  toast('Fullscreen is not available in this browser.');
}

function updateFullscreenButton() {
  const youtubeFrame = state.video?.mode === 'youtube' ? state.player?.getIframe?.() : null;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  const fullscreen = fullscreenElement === $('playerFrame') || fullscreenElement === youtubeFrame
    || !!state.player?.webkitDisplayingFullscreen;
  const button = $('fullscreenToggle');
  if (!button) return;
  button.innerHTML = fullscreen
    ? '<i class="fa-solid fa-compress" aria-hidden="true"></i><span>Exit fullscreen</span>'
    : '<i class="fa-solid fa-expand" aria-hidden="true"></i><span>Fullscreen</span>';
  button.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  button.title = fullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
}

document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
document.addEventListener('webkitbeginfullscreen', updateFullscreenButton, true);
document.addEventListener('webkitendfullscreen', updateFullscreenButton, true);

function showUrlError(message) {
  $('urlError').textContent = message;
  $('urlError').classList.remove('hidden');
}

function mountVideo(video) {
  state.ready = false;
  state.suppress = true;
  const frame = $('playerFrame');
  const fullscreenButton = $('fullscreenToggle');
  frame.replaceChildren();
  if (video.mode !== 'youtube') {
    const player = document.createElement('video');
    player.controls = state.role === 'host';
    player.playsInline = true;
    player.preload = 'metadata';
    player.src = video.url;
    player.addEventListener('loadedmetadata', () => {
      state.ready = true;
      state.suppress = false;
      syncPlayButton();
      if (state.lastState) applyState(state.lastState);
    });
    player.addEventListener('play', () => { if (!state.suppress && state.role === 'host') publishPlayerState(true); });
    player.addEventListener('pause', () => { if (!state.suppress && state.role === 'host' && !player.ended) publishPlayerState(false); });
    player.addEventListener('seeked', () => { if (!state.suppress && state.role === 'host') publishPlayerState(!player.paused); });
    player.addEventListener('error', () => {
      setPlayStatus('Video could not be loaded');
      toast('This video link is unavailable to one or more viewers. Try a public, browser-playable video URL.');
    });
    frame.append(player, fullscreenButton);
    state.player = player;
    return;
  }
  const box = document.createElement('div');
  box.id = 'ytPlayer';
  box.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  frame.append(box, fullscreenButton);
  loadYouTubeApi().then(() => {
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
          if (state.lastState) applyState(state.lastState);
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
  }).catch(() => toast('The YouTube player could not load. Check your internet connection.'));
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
    if (state.video?.mode !== 'youtube') return state.player?.currentTime || 0;
    if (state.player?.getCurrentTime) return state.player.getCurrentTime();
  } catch {}
  return 0;
}

function isPlaying() {
  try {
    if (state.video?.mode !== 'youtube') return !!state.player && !state.player.paused;
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
        if (state.video.mode !== 'youtube') state.player.currentTime = target;
        else state.player.seekTo(target, true);
      }
      state.suppress = true;
      if (state.video.mode !== 'youtube') {
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
  if (state.video.mode !== 'youtube') {
    if (state.player.paused) state.player.play().catch(() => toast('Tap play again to start the video.'));
    else state.player.pause();
  } else if (isPlaying()) state.player.pauseVideo();
  else state.player.playVideo();
}

function seekBy(delta) {
  if (state.role !== 'host' || !state.player) return;
  const time = Math.max(0, playerTime() + delta);
  if (state.video.mode !== 'youtube') state.player.currentTime = time;
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
  if (state.channel && state.client) state.client.removeChannel(state.channel);
  state.channel = null;
  state.connected = false;
  state.player = null;
  state.video = null;
  state.lastState = null;
  state.ready = false;
  state.chatSeen.clear();
  state.bannedSessions.clear();
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
  $('playerFrame').innerHTML = '<div class="placeholder"><span class="placeholder-icon"><i class="fa-solid fa-play" aria-hidden="true"></i></span><span class="placeholder-title">Your watch party starts here</span><span class="placeholder-copy">The host can load a video anytime</span></div><button id="fullscreenToggle" class="fullscreen-toggle" onclick="toggleFullscreen()" aria-label="Enter fullscreen" title="Enter fullscreen"><i class="fa-solid fa-expand" aria-hidden="true"></i><span>Fullscreen</span></button>';
  hideMentionSuggestions();
}

$('roomCode').addEventListener('input', event => {
  const code = normalizeCode(event.target.value);
  event.target.value = code ? 'PARTY-' + code : '';
});
$('roomCode').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
$('videoUrl').addEventListener('keydown', event => { if (event.key === 'Enter') loadVideo(); });

const inviteCode = new URLSearchParams(location.search).get('room');
if (inviteCode) {
  setTab('join');
  $('roomCode').value = 'PARTY-' + normalizeCode(inviteCode);
}
