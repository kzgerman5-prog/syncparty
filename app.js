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
  localStream: null,
  mediaIceServers: null,
  mediaIceServersExpiresAt: 0,
  mediaPeers: new Map(),
  mediaTiles: new Map(),
  mediaBusy: false,
  mediaRequestId: 0,
  mediaCapacityNoticeShown: false,
};

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEDIA_PARTICIPANTS = 5;
const METERED_TURN_SECRET = 'openrelayprojectsecret';

async function getMediaIceServers() {
  if (state.mediaIceServers && state.mediaIceServersExpiresAt > Date.now() + 5 * 60 * 1000) return state.mediaIceServers;
  const fallback = [{ urls: 'stun:stun.relay.metered.ca:80' }];
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const username = expiresAt + ':' + state.sessionId;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(METERED_TURN_SECRET),
      { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
    state.mediaIceServers = [
      ...fallback,
      {
        urls: [
          'turn:staticauth.openrelay.metered.ca:80?transport=udp',
          'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
          'turn:staticauth.openrelay.metered.ca:443?transport=udp',
          'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
          'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
        ],
        username,
        credential,
      },
    ];
    state.mediaIceServersExpiresAt = expiresAt * 1000;
  } catch {
    // Keep direct WebRTC available if Web Crypto is unavailable for an unusual browser.
    state.mediaIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    state.mediaIceServersExpiresAt = Date.now() + 60 * 60 * 1000;
  }
  return state.mediaIceServers;
}

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
      .on('broadcast', { event: 'rtc-offer' }, ({ payload }) => handleRtcSignal('offer', payload))
      .on('broadcast', { event: 'rtc-answer' }, ({ payload }) => handleRtcSignal('answer', payload))
      .on('broadcast', { event: 'rtc-ice' }, ({ payload }) => handleRtcSignal('ice', payload))
      .on('broadcast', { event: 'rtc-negotiate' }, ({ payload }) => handleRtcSignal('negotiate', payload))
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
        syncMediaPeers();
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        syncMediaPeers();
        if (state.role === 'host') newPresences.forEach(person => {
          if (person.sessionId === state.sessionId) return;
          if (state.bannedSessions.has(person.sessionId)) {
            broadcast('moderation', { action: 'ban', targetSessionId: person.sessionId, actorSessionId: state.sessionId });
          } else addSystem((person.name || 'A viewer') + ' joined the party.');
        });
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        syncMediaPeers();
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
        media: {
          audio: person.media?.audio === true,
          video: person.media?.video === true,
          audioEnabled: person.media?.audioEnabled !== false,
          videoEnabled: person.media?.videoEnabled !== false,
        },
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

function localMediaKinds() {
  const tracks = state.localStream?.getTracks().filter(track => track.readyState === 'live') || [];
  return {
    audio: tracks.some(track => track.kind === 'audio'),
    video: tracks.some(track => track.kind === 'video'),
  };
}

function hasLocalMedia() {
  const kinds = localMediaKinds();
  return kinds.audio || kinds.video;
}

async function trackPresence() {
  if (!state.channel || !state.connected) return false;
  try {
    const result = await state.channel.track({
      sessionId: state.sessionId,
      name: state.name,
      role: state.role,
      media: {
        ...localMediaKinds(),
        audioEnabled: state.localStream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled) ?? false,
        videoEnabled: state.localStream?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled) ?? false,
      },
    });
    return result === 'ok';
  } catch { return false; }
}

function updateMediaControls() {
  const kinds = localMediaKinds();
  const audioTrack = state.localStream?.getAudioTracks().find(track => track.readyState === 'live');
  const videoTrack = state.localStream?.getVideoTracks().find(track => track.readyState === 'live');
  const voiceJoin = $('voiceJoinButton');
  const cameraJoin = $('cameraJoinButton');
  const micToggle = $('micToggleButton');
  const cameraToggle = $('cameraToggleButton');
  const leaveButton = $('leaveMediaButton');
  if (!voiceJoin || !cameraJoin || !micToggle || !cameraToggle || !leaveButton) return;

  voiceJoin.classList.toggle('hidden', kinds.audio);
  cameraJoin.classList.toggle('hidden', kinds.video);
  micToggle.classList.toggle('hidden', !audioTrack);
  cameraToggle.classList.toggle('hidden', !videoTrack);
  leaveButton.classList.toggle('hidden', !kinds.audio && !kinds.video);
  voiceJoin.disabled = state.mediaBusy || !state.connected;
  cameraJoin.disabled = state.mediaBusy || !state.connected;
  micToggle.disabled = state.mediaBusy;
  cameraToggle.disabled = state.mediaBusy;
  leaveButton.disabled = state.mediaBusy;
  if (audioTrack) {
    micToggle.innerHTML = '<i class="fa-solid ' + (audioTrack.enabled ? 'fa-microphone-slash' : 'fa-microphone') + ' mr-1"></i>' + (audioTrack.enabled ? 'Mute mic' : 'Unmute mic');
    micToggle.setAttribute('aria-label', audioTrack.enabled ? 'Mute microphone' : 'Unmute microphone');
  }
  if (videoTrack) {
    cameraToggle.innerHTML = '<i class="fa-solid ' + (videoTrack.enabled ? 'fa-video-slash' : 'fa-video') + ' mr-1"></i>' + (videoTrack.enabled ? 'Camera off' : 'Camera on');
    cameraToggle.setAttribute('aria-label', videoTrack.enabled ? 'Turn camera off' : 'Turn camera on');
  }

  const status = $('mediaStatus');
  const reconnectButton = $('mediaReconnectButton');
  if (reconnectButton) reconnectButton.classList.toggle('hidden', !Array.from(state.mediaPeers.values())
    .some(peer => ['failed', 'disconnected'].includes(peer.pc.connectionState)));
  if (status) {
    if (state.mediaBusy) status.textContent = 'Preparing call and requesting device permission…';
    else if (!hasLocalMedia()) status.textContent = 'Your microphone and camera stay off until you choose to join.';
    else {
      const connected = Array.from(state.mediaPeers.values()).filter(peer => peer.pc.connectionState === 'connected').length;
      const kindsText = [kinds.audio ? 'voice' : '', kinds.video ? 'camera' : ''].filter(Boolean).join(' + ');
      status.textContent = 'Sharing ' + kindsText + ' · ' + connected + ' peer' + (connected === 1 ? '' : 's') + ' connected';
    }
  }
}

async function joinMedia(kind) {
  if (!['audio', 'video'].includes(kind) || state.mediaBusy) return;
  if (!state.connected || !state.channel) return toast('Wait until the room connects before joining voice or video.');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection !== 'function') {
    return toast('Voice and camera need a secure, up-to-date browser. Open SyncParty over HTTPS.');
  }
  const activeOthers = presenceList().filter(person => person.sessionId !== state.sessionId
    && (person.media.audio || person.media.video)).length;
  if (!hasLocalMedia() && activeOthers >= MAX_MEDIA_PARTICIPANTS - 1) {
    return toast('Voice and video are limited to five people at a time. Watching and chat still work.');
  }

  state.mediaBusy = true;
  const requestId = ++state.mediaRequestId;
  const requestChannel = state.channel;
  updateMediaControls();
  try {
    state.mediaIceServers = await getMediaIceServers();
    if (requestId !== state.mediaRequestId || !state.connected || state.channel !== requestChannel) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'audio' ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      video: kind === 'video' ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } } : false,
    });
    if (requestId !== state.mediaRequestId || !state.connected || state.channel !== requestChannel) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const activeCount = presenceList().filter(person => person.sessionId !== state.sessionId
      && (person.media.audio || person.media.video)).length;
    if (!hasLocalMedia() && activeCount >= MAX_MEDIA_PARTICIPANTS - 1) {
      stream.getTracks().forEach(track => track.stop());
      toast('The voice and video call filled up while you were granting permission. Watching and chat still work.');
      return;
    }
    if (!state.localStream) state.localStream = new MediaStream();
    stream.getTracks().forEach(track => {
      state.localStream.addTrack(track);
      const ownerChannel = state.channel;
      track.addEventListener('ended', () => {
        if (state.channel !== ownerChannel) return;
        trackPresence();
        syncMediaPeers();
        updateMediaControls();
      }, { once: true });
    });
    await trackPresence();
    syncMediaPeers();
    toast(kind === 'audio' ? 'You joined voice chat.' : 'Your camera is on.');
  } catch (error) {
    const message = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError'
      ? 'Microphone or camera permission was denied. Allow it in your browser settings to join.'
      : error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError'
        ? 'No matching microphone or camera was found.'
        : 'Could not start your microphone or camera. Check device permissions and try again.';
    toast(message);
  } finally {
    if (requestId === state.mediaRequestId) {
      state.mediaBusy = false;
      renderMediaParticipants();
      updateMediaControls();
    }
  }
}

function toggleMediaTrack(kind) {
  const track = state.localStream?.getTracks().find(item => item.kind === kind && item.readyState === 'live');
  if (!track) return;
  track.enabled = !track.enabled;
  renderMediaParticipants();
  updateMediaControls();
  trackPresence();
}

function retryMediaConnections() {
  const failedPeers = Array.from(state.mediaPeers.entries())
    .filter(([, peer]) => peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'disconnected');
  if (!failedPeers.length) return;
  failedPeers.forEach(([sessionId, peer]) => {
    peer.restartAttempted = false;
    requestMediaIceRestart(sessionId);
  });
  toast('Retrying the voice and video connection…');
}

function requestMediaIceRestart(remoteSessionId) {
  const peer = state.mediaPeers.get(remoteSessionId);
  if (!peer || peer.restartAttempted) return;
  peer.restartAttempted = true;
  if (state.sessionId.localeCompare(remoteSessionId) < 0) {
    try { peer.pc.restartIce(); } catch {}
  } else {
    broadcast('rtc-negotiate', {
      fromSessionId: state.sessionId,
      toSessionId: remoteSessionId,
      iceRestart: true,
    });
  }
}

async function leaveMedia() {
  if (!hasLocalMedia()) return;
  stopLocalMedia();
  await trackPresence();
  toast('You left voice and video chat.');
}

function stopLocalMedia() {
  const stream = state.localStream;
  state.localStream = null;
  if (stream) stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  Array.from(state.mediaPeers.keys()).forEach(closeMediaPeer);
  state.mediaTiles.forEach(tile => {
    tile.audio.pause();
    tile.audio.srcObject = null;
    tile.video.srcObject = null;
  });
  state.mediaTiles.clear();
  renderMediaParticipants();
  updateMediaControls();
}

function mediaTile(sessionId, name, local) {
  let tile = state.mediaTiles.get(sessionId);
  if (tile) {
    tile.name.textContent = local ? 'You' : name;
    return tile;
  }
  const root = document.createElement('div');
  root.className = 'media-tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.className = 'media-video hidden';
  const placeholder = document.createElement('div');
  placeholder.className = 'media-avatar';
  placeholder.textContent = (local ? state.name : name).trim().slice(0, 1).toUpperCase() || '?';
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.className = 'hidden';
  const footer = document.createElement('div');
  footer.className = 'media-tile-footer';
  const label = document.createElement('span');
  label.className = 'media-tile-name';
  label.textContent = local ? 'You' : name;
  const status = document.createElement('span');
  status.className = 'media-tile-status';
  status.textContent = local ? 'Your camera and mic' : 'Connecting…';
  footer.append(label, status);
  root.append(video, placeholder, audio, footer);
  root.addEventListener('click', () => {
    if (!local && audio.srcObject) audio.play().catch(() => {});
  });
  tile = { root, video, placeholder, audio, name: label, status };
  state.mediaTiles.set(sessionId, tile);
  return tile;
}

function renderMediaParticipants() {
  const grid = $('mediaGrid');
  const empty = $('mediaEmptyState');
  if (!grid || !empty) return;
  const kinds = localMediaKinds();
  const participants = hasLocalMedia()
    ? presenceList().filter(person => (person.media.audio || person.media.video)
      && (person.sessionId !== state.sessionId || hasLocalMedia()))
    : [];
  if (hasLocalMedia() && !participants.some(person => person.sessionId === state.sessionId)) {
    participants.push({ sessionId: state.sessionId, name: state.name, media: kinds });
  }
  participants.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const activeIds = new Set(participants.map(person => person.sessionId));
  state.mediaTiles.forEach((tile, id) => {
    if (!activeIds.has(id)) {
      tile.audio.pause();
      tile.audio.srcObject = null;
      tile.video.srcObject = null;
      state.mediaTiles.delete(id);
    }
  });
  grid.replaceChildren();
  participants.forEach(person => {
    const local = person.sessionId === state.sessionId;
    const tile = mediaTile(person.sessionId, person.name, local);
    const peer = state.mediaPeers.get(person.sessionId);
    const stream = local ? state.localStream : peer?.remoteStream;
    if (tile.video.srcObject !== (stream || null)) tile.video.srcObject = stream || null;
    if (tile.audio.srcObject !== (local ? null : stream || null)) {
      tile.audio.srcObject = local ? null : stream || null;
      if (!local && stream) tile.audio.play().catch(() => {
        tile.status.textContent = 'Tap here to enable audio';
      });
    }
    const videoTrack = stream?.getVideoTracks().find(track => track.readyState === 'live');
    const showVideo = !!videoTrack && (local ? videoTrack.enabled : person.media.videoEnabled !== false && !videoTrack.muted);
    tile.video.classList.toggle('hidden', !showVideo);
    tile.placeholder.classList.toggle('hidden', showVideo);
    if (local) {
      tile.status.textContent = [kinds.audio ? (state.localStream.getAudioTracks().some(track => track.enabled) ? 'Mic on' : 'Mic muted') : '', kinds.video ? (videoTrack?.enabled ? 'Camera on' : 'Camera off') : ''].filter(Boolean).join(' · ');
    } else if (!peer) tile.status.textContent = 'Connecting…';
    else if (peer.pc.connectionState === 'failed') tile.status.textContent = 'Could not connect · retry below';
    else if (peer.pc.connectionState === 'disconnected') tile.status.textContent = 'Reconnecting…';
    else if (peer.pc.connectionState === 'connected') tile.status.textContent = [person.media.audio ? (person.media.audioEnabled ? 'Voice' : 'Muted') : '', person.media.video ? (person.media.videoEnabled ? 'Camera' : 'Camera off') : ''].filter(Boolean).join(' · ');
    else tile.status.textContent = 'Connecting…';
    grid.append(tile.root);
  });
  empty.classList.toggle('hidden', participants.length > 0);
}

function syncMediaPeers() {
  renderMediaParticipants();
  if (!hasLocalMedia() || !state.connected) {
    Array.from(state.mediaPeers.keys()).forEach(closeMediaPeer);
    updateMediaControls();
    return;
  }
  const active = presenceList().filter(person => person.media.audio || person.media.video);
  if (!active.some(person => person.sessionId === state.sessionId)) {
    active.push({ sessionId: state.sessionId, name: state.name, role: state.role, media: localMediaKinds() });
  }
  active.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (active.length > MAX_MEDIA_PARTICIPANTS) {
    const allowed = new Set(active.slice(0, MAX_MEDIA_PARTICIPANTS).map(person => person.sessionId));
    if (!allowed.has(state.sessionId)) {
      stopLocalMedia();
      trackPresence();
      toast('The voice and video call is full (five people). You can still watch and chat.');
      return;
    }
    if (!state.mediaCapacityNoticeShown) {
      toast('Voice and video support up to five people. Other room members can still watch and chat.');
      state.mediaCapacityNoticeShown = true;
    }
  }
  const eligible = new Set(active.filter(person => person.sessionId !== state.sessionId)
    .slice(0, MAX_MEDIA_PARTICIPANTS - 1).map(person => person.sessionId));
  Array.from(state.mediaPeers.keys()).forEach(sessionId => {
    if (!eligible.has(sessionId)) closeMediaPeer(sessionId);
  });
  active.filter(person => person.sessionId !== state.sessionId && eligible.has(person.sessionId)).forEach(person => {
    if (!state.mediaPeers.has(person.sessionId)) createMediaPeer(person.sessionId);
  });
  renderMediaParticipants();
  updateMediaControls();
}

function createMediaPeer(remoteSessionId) {
  if (typeof RTCPeerConnection !== 'function' || state.mediaPeers.has(remoteSessionId)) return state.mediaPeers.get(remoteSessionId);
  const pc = new RTCPeerConnection({ iceServers: state.mediaIceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
  const peer = { pc, remoteStream: new MediaStream(), makingOffer: false, offerAgain: false, pendingIce: [] };
  state.mediaPeers.set(remoteSessionId, peer);
  state.localStream?.getTracks().filter(track => track.readyState === 'live').forEach(track => pc.addTrack(track, state.localStream));
  pc.onicecandidate = event => {
    if (event.candidate) broadcast('rtc-ice', {
      fromSessionId: state.sessionId,
      toSessionId: remoteSessionId,
      candidate: event.candidate.toJSON(),
    });
  };
  pc.ontrack = event => {
    const stream = event.streams?.[0];
    if (stream) stream.getTracks().forEach(track => {
      if (!peer.remoteStream.getTracks().some(existing => existing.id === track.id)) peer.remoteStream.addTrack(track);
    });
    else if (!peer.remoteStream.getTracks().some(track => track.id === event.track.id)) peer.remoteStream.addTrack(event.track);
    event.track.addEventListener('mute', renderMediaParticipants);
    event.track.addEventListener('unmute', renderMediaParticipants);
    event.track.addEventListener('ended', renderMediaParticipants);
    renderMediaParticipants();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') peer.restartAttempted = false;
    renderMediaParticipants();
    updateMediaControls();
    if (pc.connectionState === 'failed') {
      requestMediaIceRestart(remoteSessionId);
      toast('The connection dropped. Trying the free network relay…');
    }
  };
  pc.onnegotiationneeded = () => requestPeerNegotiation(remoteSessionId);
  return peer;
}

function closeMediaPeer(remoteSessionId) {
  const peer = state.mediaPeers.get(remoteSessionId);
  if (!peer) return;
  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.onconnectionstatechange = null;
  peer.pc.onnegotiationneeded = null;
  try { peer.pc.close(); } catch {}
  peer.remoteStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
  state.mediaPeers.delete(remoteSessionId);
  const tile = state.mediaTiles.get(remoteSessionId);
  if (tile) {
    tile.audio.pause();
    tile.audio.srcObject = null;
    tile.video.srcObject = null;
    tile.root.remove();
    state.mediaTiles.delete(remoteSessionId);
  }
}

function requestPeerNegotiation(remoteSessionId) {
  const peer = state.mediaPeers.get(remoteSessionId);
  if (!peer) return;
  if (!peer.pc.localDescription && !peer.pc.remoteDescription) {
    if (state.sessionId.localeCompare(remoteSessionId) < 0) makePeerOffer(remoteSessionId);
    return;
  }
  if (state.sessionId.localeCompare(remoteSessionId) < 0) {
    makePeerOffer(remoteSessionId);
  } else {
    broadcast('rtc-negotiate', { fromSessionId: state.sessionId, toSessionId: remoteSessionId });
  }
}

async function makePeerOffer(remoteSessionId) {
  const peer = state.mediaPeers.get(remoteSessionId);
  if (!peer || peer.makingOffer || peer.pc.signalingState !== 'stable') {
    if (peer) peer.offerAgain = true;
    return;
  }
  peer.makingOffer = true;
  try {
    const offer = await peer.pc.createOffer();
    if (peer.pc.signalingState !== 'stable') return;
    await peer.pc.setLocalDescription(offer);
    await broadcast('rtc-offer', {
      fromSessionId: state.sessionId,
      toSessionId: remoteSessionId,
      description: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp },
    });
  } catch {
    toast('Could not start a peer voice or video connection. Try leaving and rejoining media.');
  } finally {
    peer.makingOffer = false;
    if (peer.offerAgain) {
      peer.offerAgain = false;
      setTimeout(() => makePeerOffer(remoteSessionId), 0);
    }
  }
}

async function handleRtcSignal(kind, payload) {
  if (!payload || payload.toSessionId !== state.sessionId || typeof payload.fromSessionId !== 'string'
    || payload.fromSessionId === state.sessionId || !state.connected || !hasLocalMedia()) return;
  const remote = presenceList().find(person => person.sessionId === payload.fromSessionId
    && (person.media.audio || person.media.video));
  if (!remote) return;
  if (kind === 'negotiate') {
    if (state.sessionId.localeCompare(remote.sessionId) < 0) {
      if (payload.iceRestart) {
        const peer = createMediaPeer(remote.sessionId);
        if (peer) peer.restartAttempted = true;
        try { peer?.pc.restartIce(); } catch {}
      } else await makePeerOffer(remote.sessionId);
    }
    return;
  }
  const peer = createMediaPeer(remote.sessionId);
  if (!peer) return;
  const pc = peer.pc;
  try {
    if (kind === 'offer') {
      if (state.sessionId.localeCompare(remote.sessionId) < 0 || !payload.description?.sdp
        || payload.description.sdp.length > 100000 || pc.signalingState !== 'stable') return;
      await pc.setRemoteDescription(payload.description);
      for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await broadcast('rtc-answer', {
        fromSessionId: state.sessionId,
        toSessionId: remote.sessionId,
        description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    } else if (kind === 'answer') {
      if (state.sessionId.localeCompare(remote.sessionId) > 0 || !payload.description?.sdp
        || payload.description.sdp.length > 100000 || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(payload.description);
      for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
      if (peer.offerAgain) {
        peer.offerAgain = false;
        setTimeout(() => makePeerOffer(remote.sessionId), 0);
      }
    } else if (kind === 'ice' && payload.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
      else if (peer.pendingIce.length < 100) peer.pendingIce.push(payload.candidate);
    }
  } catch {
    renderMediaParticipants();
  }
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
  state.mediaRequestId += 1;
  state.mediaBusy = false;
  stopLocalMedia();
  state.mediaTiles.forEach(tile => tile.root.remove());
  state.mediaTiles.clear();
  $('mediaGrid')?.replaceChildren();
  $('mediaEmptyState')?.classList.remove('hidden');
  state.mediaCapacityNoticeShown = false;
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
