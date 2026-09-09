# Deploying Resuto

The app is a plain Node HTTP server. All persistence — restaurant state and
menu images alike — lives in Firestore, so the host needs no database and no
persistent disk.

## Why this split

Firebase has no free way to run server-side code: Cloud Functions, Cloud Run and
App Hosting all require the Blaze plan, which requires a billing account. This
app cannot move its logic to the browser, because pricing, stock, roles,
idempotency and payment confirmation are all enforced on the server and would
be trivially bypassed otherwise.

So the server runs on Render's free tier, while Firestore and Firebase Auth keep
the data. Nothing here needs a card.

## 1. Firebase (data)

1. In the Firebase console open **Project settings → Service accounts** and
   generate a new private key. A JSON file downloads.
2. Keep that file secret. It is a credential, not a config: anyone holding it
   can read and write the whole database.
3. Review `firestore.rules` before going live. The web API key in
   `public/firebase-client.js` is public by design — these rules, not that key,
   are what protect the data.

## 2. Render (server)

Create a **Web Service** from this repository. `render.yaml` already sets the
build and start commands, the health check and the free plan, so only the
secrets are left. Add these under **Environment**:

| Variable | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the whole service-account JSON, or a base64 copy of it |
| `APP_ORIGIN` | `https://<your-service>.onrender.com` |
| `MANAGER_PASSWORD` | a strong password |
| `KITCHEN_PASSWORD` | a strong password |
| `HOST_PASSWORD` | a strong password |
| `GEMINI_API_KEY` | optional — without it the AI features fall back to labelled demo rules |

`APP_ORIGIN` must match the deployed URL exactly. It is what QR codes, share
links and payment return URLs are built from, and cross-origin writes are
refused against it.

If your editor mangles multi-line values, base64 the JSON instead —
`base64 -i service-account.json | pbcopy` — and paste that. The server accepts
either form.

## 3. After the first deploy

- Open `/manager` and sign in to confirm the roles work.
- Print the QR codes from **Floor overview → QR print sheet**, or the single
  venue QR from **Settings** when running counter service. They encode
  `APP_ORIGIN`, so set it before printing anything.

## Known limits of the free tier

- **The service sleeps when idle.** The first request after a quiet period takes
  roughly half a minute while it wakes. Guests scanning a QR at a quiet table
  will feel this.
- **Firestore free quotas apply** (50k reads and 20k writes per day). The cached,
  listener-backed read path in `firebase-platform.js` keeps reads far below that
  for a single restaurant, since repeat reads are served from memory.
- **No persistent disk**, which is why media goes to Firestore rather than
  `data/media`. Do not reintroduce a filesystem dependency.

## Local development

```
cp .env.example .env      # fill in the passwords
npm install
npm start                 # http://localhost:3000
```

Without `FIREBASE_TENANT_MODE=true` the server uses SQLite under `./data`, which
is the fastest way to work offline. `npm test` runs the full suite; the Firebase
paths are exercised by `npm run test:firebase` against the emulators declared in
`firebase.json`.
