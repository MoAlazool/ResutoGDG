# Firebase SaaS setup

Resuto uses Firebase Authentication for user credentials and Cloud Firestore
as the tenant store. Photos remain in the existing media store or static
assets; Firestore does not store image binaries.

## Data model

- `restaurants/{restaurantId}`: safe account metadata and subscription state.
- `restaurants/{restaurantId}/private/state`: server-only operational state.
- `users/{uid}`: user profile and last selected restaurant.
- `users/{uid}/memberships/{restaurantId}`: the user's role in that restaurant.
- `restaurantSlugs/{slug}`: public slug-to-restaurant lookup.

Every authenticated API request is verified with Firebase Admin. The server
loads the membership first, selects exactly one restaurant tenant, and only
then runs Manager, Kitchen or Host operations. Firestore rules deny all client
access to operational state and all client writes to account records.

## Local setup

1. Build the browser SDK bundle with `npm run build:client`.
2. For local Firebase emulators, set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`,
   `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, and
   `FIREBASE_TENANT_MODE=true` before starting the server.
3. For the live project, provide Application Default Credentials with access
   to `resuto-cf8f5` and set `FIREBASE_TENANT_MODE=true`. On Firebase-managed
   compute, credentials are provided by the service account automatically.
4. Deploy the locked-down rules with `firebase deploy --only firestore:rules`.

Email/password and Google must remain enabled in Firebase Authentication. Add
each production domain to Authentication > Settings > Authorized domains.

## Hosting note

`firebase.json` is ready for the static frontend. The `/api` server must be
deployed to trusted server compute (Firebase Functions, Cloud Run, or the
current Netlify function) before the final Hosting deployment; do not deploy
the static-only rewrite as a production cutover until that API rewrite target
is configured.
