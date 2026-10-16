# SyncParty

One person creates a room and becomes the host. Friends join with a room code or invite link. The host controls a video, and everyone's player stays in sync automatically. Rooms include live chat and a viewer list.

## Setup

The room service uses Supabase Realtime. The project URL and publishable key are in `config.js`; these are browser-visible values. Never put a secret or `service_role` key in this static app. Enable public Realtime channels in the Supabase project.

To let hosts upload a local video so room members can watch it, create a public Supabase Storage bucket and allow room uploads. In the Supabase SQL Editor, run:

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'syncparty-videos', 'syncparty-videos', true, 524288000,
  array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg', 'video/mpeg', 'video/x-msvideo', 'video/x-ms-wmv', 'video/3gpp', 'video/x-m4v', 'video/x-flv']
)
on conflict (id) do update set public = true, file_size_limit = 524288000;

create policy "SyncParty videos are readable"
on storage.objects for select to public
using (bucket_id = 'syncparty-videos');

create policy "Room members can upload SyncParty videos"
on storage.objects for insert to anon
with check (
  bucket_id = 'syncparty-videos'
  and (storage.foldername(name))[1] ~ '^[A-Z0-9]{10}$'
);
```

The upload control accepts video files up to 500 MB. Files are stored in the public bucket so every viewer can load the same URL. Anyone with the app's public Supabase configuration can upload to this bucket, so monitor storage use and remove old uploads when they are no longer needed. To use another bucket, set `storageBucket` in `config.js` and adjust the SQL policies to match.

## Video playback

Hosts can load YouTube links or direct video file URLs supported by the viewer's browser (such as MP4 and WebM). A webpage link from a streaming service is not necessarily a playable video URL: providers that block embedding or do not expose a browser-playable media URL cannot be synced by this static player. Uploaded local files are first sent to the configured Storage bucket, then shared with the room. The host's controls and playback position are broadcast through Supabase Realtime.

The player stays within a 16:9 frame on desktop and mobile. Use its fullscreen button to enter or leave fullscreen. The theme button switches between light and dark mode and remembers the selection. Chat has a fixed height; type `@` and choose a room member to insert a mention. New messages keep the latest view in sight unless you have scrolled up to read older messages.

## Run and deploy

Serve the folder over HTTP (for example, `python -m http.server 8000`) and open `http://localhost:8000`. GitHub Pages deployment is configured in `.github/workflows/pages.yml`; select GitHub Actions in **Settings → Pages → Build and deployment**.

Rooms use random 10-character codes. Chat and viewer presence are temporary; the app does not store messages in a database. Remove/ban actions and host transfer are intended for friendly rooms: public Realtime channels do not provide account-based host authorization, so these controls are not a security boundary. Bans are kept in the current host tab's memory and can be bypassed by reconnecting with a new session.

## Built with

Vanilla HTML, CSS, and JavaScript; Supabase Realtime and Storage; the YouTube IFrame API; Font Awesome from a public CDN.
