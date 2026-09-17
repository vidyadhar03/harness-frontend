# MotionX Location Studio

A minimal Next.js workspace for reviewing location briefs, collecting visual inspiration, and approving a concept for blockout planning.

## Run

```sh
npm ci
npm run dev
```

Open http://localhost:3000. `npm run build` produces a static Next.js export in `out/`.

## Included

- Location navigation, add, rename, merge and defer.
- Editable working brief, requirements and open questions.
- Reference selection, individual usage guidance, image preview and local uploads.
- Concept uploads, versions, visual-direction approval and JSON handoff export.
- Persistent discussion panel and browser storage via IndexedDB.
- Optional asynchronous harness job and chat integration.

The initial Dehleez project is illustrative sample data. The Python harness, Firestore and GCS are not connected. No AI response or generation is simulated. Clearing browser site data removes locally saved work. Each browser/device has its own workspace. Uploaded images remain in the browser unless you export them or send a request to a configured harness API.

See API_CONTRACT.md to connect the backend. `.env.example` documents the optional API URL. A static export needs rebuilding after changing that variable.

## Reference attribution

Sample photographs are downloaded Wikimedia Commons previews. The original source links and per-image author/license credits are available in the image detail dialog and `lib/model.ts`. Preserve those credits when redistributing. Reference images are visual inspiration, not shooting-location recommendations.

## Scope

Approval locks a visual concept only. The exported brief preserves unresolved questions for subsequent 3D geometry decisions. This frontend does not create a 3D blockout or infer dimensions from a photograph.
