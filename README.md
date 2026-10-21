# Suno Studio

A one-page AI music generator built on the [Suno API](https://docs.sunoapi.org), ready to deploy on Netlify.

## Features

- **Bring your own API key** – entered at runtime, kept only in the tab's memory. It is never saved to storage, the repo, or the server, and it's gone when you reload.
- **Simple mode** – describe a song and Suno writes the lyrics and music.
- **Custom mode** – title, style tags, your own lyrics, excluded styles, vocal gender, duration, and style/weirdness/variety controls.
- **AI lyrics** – generate lyric options from a short idea and drop them into the editor.
- **Instrumental toggle** and model picker (V6, V6 Wild, V6 Mini).
- **Live progress** – polls task status; the first track can stream before the full result is done.
- **Track library** – cover art, player, lyrics, MP3 download, copy link, and **Extend** a track from any point. Track info (not the key) is kept in localStorage.
- **Credits balance** shown in the header.

## How it works

```
public/                  static page (index.html, styles.css, app.js)
netlify/functions/
  suno.mjs               proxy: /api/suno/v1/* -> https://api.sunoapi.org/api/v1/*
  callback.mjs           /api/callback – acknowledges Suno's required callback
netlify.toml
```

The browser sends the user's key in the `Authorization` header with each request. The proxy function
forwards it to Suno, which avoids browser CORS limits. It only allows the endpoints the app uses and
never logs or stores the key. Suno requires a `callBackUrl` on every task, so the app points it at
`/api/callback` and polls for results.

## Deploy to Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this repo (`main` branch).
2. Leave the build command empty. `netlify.toml` already sets the publish directory (`public`) and functions directory.
3. Deploy, open the site, and paste your API key from [sunoapi.org/api-key](https://sunoapi.org/api-key).

You don't need any environment variables.

## Run locally

```bash
npm install -g netlify-cli
netlify dev
```

Opening `index.html` directly won't work, because the app needs the `/api/*` functions.
