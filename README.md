# SyncParty

Make a room, send the invite link, and watch together. The host controls a shared YouTube or public MP4 player; guests follow playback and can chat. Voice and camera are optional, off by default, and available when someone chooses to join.

## One-time project setup

The room service uses Supabase Realtime. This replaces direct browser-to-browser connections, which can be blocked by school, mobile, or home network firewalls.

1. Create a Supabase project.
2. Copy its Project URL and **publishable** key from the project's Connect dialog. Make sure public Realtime channels are enabled in the project's Realtime settings.
3. Paste them into `config.js`. Do not use a secret or `service_role` key.
4. Push the project to the `main` branch of GitHub. The Pages workflow deploys the static app after `config.js` has real project values.

Room channels use Supabase's public Broadcast and Presence features. Each room has a random 10-character code. Messages and viewer presence are temporary; the app does not store chat or video files in a database. The publishable key and project URL are visible to site visitors by design; never put a secret or `service_role` key in this static app. The room creator does this setup once. Everyone using the app just creates a room or opens an invite link.

## Voice and camera

The room includes **Join voice**, **Join with camera**, microphone mute, camera on/off, and **Leave call** controls. Media stays off until a user chooses to join and grants the browser permission.

Voice and camera use an embedded Jitsi conference on the free, no-account Freifunk München service. SyncParty automatically creates the same call room from the watch-party code, so participants do not enter server details or configure a backend. The service reports a 70-person room limit but is community-operated and has no uptime guarantee. If the embedded call is blocked by a browser or network, the app offers a direct link to the same call. [Freifunk München service information](https://www.ffmuc.net/wiki/knb:meet-en).

Call audio and video are processed by the Jitsi service and are not end-to-end encrypted. The provider may see connection metadata. SyncParty does not screen-share or send the watch-party video through the call; each viewer plays the video in their own YouTube or MP4 player. Supabase Realtime continues to handle room presence and chat.
## Run locally

Serve the folder over HTTP (for example, `python -m http.server 8000`) and open `http://localhost:8000`. Paste the same Supabase URL and publishable key into `config.js` first.

## Video links

Each viewer's device loads the video directly from YouTube or the supplied MP4 URL. YouTube videos must allow embedded playback. MP4 links must be public, playable in a browser, and reachable from each viewer's network. SyncParty sends playback state; it does not relay or host video files.

Use **Full screen** on the video to expand the player and **Minimise** to return it to the page. The control works with the embedded player and direct video elements where the browser supports the Fullscreen API.

## Chat and host controls

The chat panel has a fixed, viewport-aware height. Messages scroll inside the panel, and the view stays where you left it when new messages arrive. Type `@` to pick a room member; mentions show an in-app notification and use a browser notification when permission was already granted and the tab is in the background.

Hosts can remove or ban a viewer, or transfer host controls to a guest, using the **Manage** menu beside each viewer. These controls use public Supabase Realtime messages and browser-session IDs. They are for friendly rooms, not a security boundary: a determined user can bypass them, and bans last for the active room in the host's current tab.

## Deploy with GitHub Pages

In the repository, open **Settings → Pages → Build and deployment** and select **GitHub Actions**. Push to `main` to deploy using `.github/workflows/pages.yml`.

## Built with

Vanilla HTML, CSS, and JavaScript; Supabase Realtime; the YouTube IFrame API; Tailwind CSS and Font Awesome from public CDNs.
