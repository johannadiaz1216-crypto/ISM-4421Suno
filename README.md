# Suno Studio

A one-page AI music generator built on the [Suno API](https://docs.sunoapi.org), ready to deploy on Netlify.

## Features

- **Email login** – sign up, sign in, forgot/reset password, sign out (Supabase Auth). The app and the API proxy only work for signed-in users.
- **User profiles** – first sign-in asks each user to create a profile: display name, unique @username, bio, favorite genres (shown first as style suggestions) and a photo (cropped and resized to 256px in the browser).
- **Bring your own API key** – entered at runtime, kept only in the tab's memory. It is never saved to storage, the repo, or the server, and it's gone when you reload.
- **Simple mode** – describe a song and Suno writes the lyrics and music.
- **Custom mode** – title, style tags, your own lyrics, excluded styles, vocal gender, duration, and style/weirdness/variety controls.
- **AI lyrics** – generate lyric options from a short idea and drop them into the editor.
- **Instrumental toggle** and model picker (V6, V6 Wild, V6 Mini).
- **Live progress** – polls task status; the first track can stream before the full result is done.
- **Track library** – cover art, player, lyrics, MP3 download, copy link, and **Extend** a track from any point. Track info (not the key) is kept in localStorage, separately for each account.
- **Credits balance** shown in the header.

## How it works

```
public/
  index.html, styles.css
  config.js              Supabase project URL + publishable key (public by design)
  auth.js                email/password sign-in UI (Supabase Auth)
  profile.js             profile create/edit + avatar upload
  app.js                 music app
  vendor/                supabase-js 2.117.2 UMD build (vendored, no CDN)
netlify/functions/
  suno.mjs               proxy: /api/suno/v1/* -> https://api.sunoapi.org/api/v1/*  (signed-in users only)
  callback.mjs           /api/callback – acknowledges Suno's required callback
netlify/lib/auth.mjs     verifies Supabase session tokens (ES256) against the project's public JWKS
netlify.toml
supabase/migrations/     database changes applied to the Supabase project
```

**Login enforcement.** The browser sends its Supabase session token in an `X-Supabase-Auth` header. The proxy
checks the token's signature against the project's public signing keys
(`/auth/v1/.well-known/jwks.json`), and also checks the issuer, audience, role and expiry. Requests without a
valid session get a 401. This needs no secrets or environment variables. Set `SUPABASE_URL` only if you move to
another Supabase project.

**Database.** Supabase Auth stores users in `auth.users`. The `on_auth_user_created` trigger creates an empty
`public.profiles` row for each new user, and the app asks them to fill it in on first sign-in.

| Column | Rules |
| --- | --- |
| `display_name` | required by the app, 1–50 chars |
| `username` | optional, unique, `^[a-z0-9_]{3,20}$` |
| `bio` | optional, up to 280 chars |
| `favorite_genres` | up to 8 |
| `avatar_path` | file in the `avatars` bucket, must be inside the user's own folder |

Security:
- Row Level Security limits each user to reading, creating and updating **only their own row**.
- Column-level grants block changes to `id` and `email`.
- Anonymous users get no access, and `TRUNCATE` is revoked for everyone.
- Avatars live in the public-read `avatars` storage bucket (images only, 2 MB max). Users can upload or delete
  files only in `avatars/<their user id>/`. Photo URLs are unguessable but public, which is normal for avatars.

See `supabase/migrations/` for the exact SQL.

The browser sends the user's key in the `Authorization` header with each request. The proxy function
forwards it to Suno, which avoids browser CORS limits. It only allows the endpoints the app uses and
never logs or stores the key. Suno requires a `callBackUrl` on every task, so the app points it at
`/api/callback` and polls for results.

## Deploy to Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this repo (`main` branch).
2. Leave the build command empty. `netlify.toml` already sets the publish directory (`public`) and functions directory.
3. Deploy and copy your site URL (for example `https://your-site.netlify.app`).
4. In Supabase, go to **Authentication → URL Configuration**:
   - **Site URL**: your Netlify URL
   - **Redirect URLs**: add `https://your-site.netlify.app/**` (and `http://localhost:8888/**` for `netlify dev`)

   Without this, confirmation and password-reset emails send people to `localhost:3000`.
5. Open the site, create an account, confirm your email, sign in, and paste your Suno API key.

You don't need any environment variables.

### Letting other people sign up

Supabase's built-in email sender **only delivers to members of your Supabase team** and is limited to a few
emails per hour. Your own address works. For anyone else, choose one:

- **Recommended:** add a custom SMTP provider (for example Resend, SendGrid or Postmark) in **Authentication → SMTP Settings**.
- **Quickest:** turn off **Authentication → Sign In / Providers → Email → Confirm email**. New accounts can then
  sign in right away with no email sent. Forgot-password emails still need SMTP.

## Run locally

```bash
npm install -g netlify-cli
netlify dev
```

Opening `index.html` directly won't work, because the app needs the `/api/*` functions.
