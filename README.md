# God'sgrace Ethics Football Battle — Multiplayer server starter

## What this provides
- Socket.IO connection
- Random 1v1 matchmaking
- Create/join private two-player rooms
- Match start and score updates
- WebRTC signaling relay (`voice:signal`) for browser live voice

## Deploy on Render
1. Upload these files into a separate GitHub repository (recommended name: `football-battle-server`).
2. In Render, choose **New + → Web Service**, connect that server repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Deploy. Test the service URL; the root should say the server is running and `/health` should return `{ "ok": true }`.

## Client events
- Emit `player:name` with a display name
- Emit `match:find` for random matchmaking
- Emit `room:create`; receive `room:created` with room code
- Emit `room:join` with room code
- Emit `match:start` once two players are in the room
- Emit `score:update` with a score
- WebRTC clients relay `offer`, `answer`, and `ice-candidate` payloads using `voice:signal`; listen for `voice:signal`

## Important limitations
This is a **backend starter**, not a finished integrated multiplayer game.** The current HTML quiz still needs its frontend rewritten to use these events and WebRTC APIs. For reliable voice across restrictive networks, configure a TURN service (STUN alone is not enough). Add authentication, input validation/rate limits, moderation/report controls, and secure room permissions before public launch. Do not collect sensitive personal information; use display names only.
