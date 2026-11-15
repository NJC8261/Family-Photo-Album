# Photo Albums

A small self-hosted website for sharing photos and PDFs. It does not depend on Claude or any third-party service, and it has **zero npm dependencies**.

- Share an **album by link**. Anyone with the link can open it on any phone, tablet or computer.
- **Swipe** through photos (touch swipe, trackpad, arrow keys, or on-screen buttons) and open an "All" grid.
- **Original-quality downloads**: single files are served byte-for-byte as uploaded (no re-encoding, no compression). "Download all" is an uncompressed (stored) ZIP.
- Works in any modern browser: iOS/Android, Windows, macOS, Linux, ChromeOS.
- Supports JPEG, PNG, GIF, WebP, AVIF, HEIC/HEIF, TIFF, BMP, PDF, and MP4/MOV/WebM video.

## Run it

Requires Node.js 20.15 or newer.

```bash
ADMIN_PASSWORD='choose-a-strong-password' node server.js
# open http://localhost:3000
```

If you don't set `ADMIN_PASSWORD`, a random one is generated on first start and printed once in the console.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | generated | Password for the owner page (`/`). |
| `PORT` | `3000` | Port to listen on. |
| `DATA_DIR` | `./data` | Where originals, previews and the album database live. **Back this up.** |
| `MAX_FILE_MB` | `2000` | Largest single upload. |
| `TRUST_PROXY` | off | Set to `1` if behind a reverse proxy, so login throttling uses the real client IP. |

## Publish it

You need somewhere that runs Node (or Docker) **with a persistent disk**, because photos are stored on disk. Options: a small VPS (DigitalOcean, Hetzner, Linode), Fly.io, Railway, or Render, each with a volume mounted at `DATA_DIR`.

**Docker:**
```bash
docker build -t photo-albums .
docker run -d -p 3000:3000 -v photo-data:/data -e ADMIN_PASSWORD='...' photo-albums
```

**Use HTTPS.** Put it behind a platform-provided HTTPS endpoint, or a reverse proxy such as Caddy:
```
albums.example.com {
    reverse_proxy localhost:3000
}
```
(Caddy gets the certificate automatically. If you use nginx, set `client_max_body_size 0;` and `proxy_request_buffering off;` so large uploads work.)

Static-only hosts (GitHub Pages, Netlify static, etc.) will **not** work, because uploading and link-sharing need a server.

## Using it

1. Open your site, sign in, **Create album**.
2. Add photos/PDFs (many at once is fine). Images get a fast preview for swiping; the original is kept untouched.
3. Tap **Copy link** (or **Share…** on phones) and send it to people.
4. **New link** revokes the old link instantly if it leaks.

## Notes and limits

- **Anyone with a link can view and download the originals.** Links are 144-bit random, so they can't be guessed, but treat them like a password.
- The "Download all" ZIP is limited to 4 GB total / 65,535 files (classic ZIP). Larger albums can be downloaded file by file.
- HEIC/HEIF photos are stored and downloadable, but only Safari can *display* them; other browsers show a card with a download button.
- Previews are generated in the uploader's browser (JPEG/PNG/WebP/AVIF over 400 KB). If that fails, the original is used for display.
- Only the owner (password) can upload or delete. Guest uploading is not included.
- Albums are stored in `DATA_DIR/db.json` and `DATA_DIR/files/`. To back up, copy the whole `DATA_DIR`.

## Files

```
server.js          the whole backend
public/index.html  owner dashboard      public/app.js    its logic
public/view.html   shared album viewer  public/view.js   swipe viewer logic
public/style.css   shared styles
Dockerfile         container build
```
