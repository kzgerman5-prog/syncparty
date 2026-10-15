# SyncParty

Make a room, send the invite link, and watch together. The host controls a shared YouTube or public MP4 player; guests follow playback and can chat. No accounts, ports, or network settings for viewers.

## One-time project setup

The room service uses Supabase Realtime. This replaces direct browser-to-browser connections, which can be blocked by school, mobile, or home network firewalls.

1. Create a Supabase project.
2. Copy its Project URL and **publishable** key from the project's Connect dialog. Make sure public Realtime channels are enabled in the project's Realtime settings.
3. Paste them into `config.js`. Do not use a secret or `service_role` key.
4. Push the project to the `main` branch of GitHub. The Pages workflow deploys the static app after `config.js` has real project values.

Room channels use Supabase's public Broadcast and Presence features. Each room has a random 10-character code. Messages and viewer presence are temporary; the app does not store chat or video files in a database. The publishable key and project URL are visible to site visitors by design; never put a secret or `service_role` key in this static app. The room creator does this setup once. Everyone using the app just creates a room or opens an invite link.

## Run locally

Serve the folder over HTTP (for example, `python -m http.server 8000`) and open `http://localhost:8000`. Paste the same Supabase URL and publishable key into `config.js` first.

## Video links

Each viewer's device loads the video directly from YouTube or the supplied MP4 URL. YouTube videos must allow embedded playback. MP4 links must be public, playable in a browser, and reachable from each viewer's network. SyncParty sends playback state; it does not relay or host video files.

## Deploy with GitHub Pages

In the repository, open **Settings → Pages → Build and deployment** and select **GitHub Actions**. Push to `main` to deploy using `.github/workflows/pages.yml`.

## Built with

Vanilla HTML, CSS, and JavaScript; Supabase Realtime; the YouTube IFrame API; Tailwind CSS and Font Awesome from public CDNs.
