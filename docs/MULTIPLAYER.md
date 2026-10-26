# Running multiplayer

1. Copy `.env.example` to `.env.local` and set `VITE_WS_URL` to the backend's actual WebSocket URL, including its path. Restart Vite after changing it. Use `wss://` when serving the frontend over HTTPS.
2. Start the separate Node.js backend implementing `WEBSOCKET.md` and `PROTOCOLS.md`. Without `VITE_WS_URL`, HTTP development connects to `ws://localhost:3000/`; HTTPS connects to `wss://<frontend-host>/`. Configure the actual backend URL for deployment; Vite does not provide a multiplayer backend.
3. Open the frontend in two browser tabs. Choose each player's name and appearance in the dressing room, then enter the world.
4. Check that both characters appear, movement and animations synchronize, and leaving removes the character from the other tab. Five clients may join; the backend must reject a sixth with `server:error` / `ROOM_FULL`.
5. Restart the backend to check reconnect behavior. Each reconnect sends a fresh join with the same name and appearance and accepts the new backend-assigned ID.

The frontend calculates local movement and Rapier collision results, then sends `player:move` with `sequence`, `position: { x, y, z }`, `rotation`, and `animation`. The existing socket publishes changed states at a maximum of 20 Hz, including a final Idle state. It sends no unchanged states, player IDs, or appearance in movement messages. The backend supplies the initial spawn in `world:init`, stores accepted reported states, and forwards them to other players. It must implement the updated protocol; older input-simulation backends are incompatible.

The client follows `WEBSOCKET.md`: names are trimmed and restricted to 1–24 characters, walking and vehicle movement use separate rolling 20-message budgets, and enter/exit share a rolling two-request budget. JSON payloads exceeding 4 KiB are not sent; a backed-up socket defers movement rather than building a stale queue. Vehicle exits wait for the server acknowledgement of the final stopped report. Walking positions retain finite-number validation without vehicle coordinate bounds.

WASD and the arrow keys follow the camera viewpoint continuously. Up/Down/Left/Right are alternatives to W/S/A/D, and Shift runs with either set of keys. Holding both keys for the same direction does not increase speed. Movement keys prevent browser scrolling during gameplay and remain available for editing when chat is focused. `movementAdapter.ts` translates keys into a normalized local world direction, including equal-speed diagonals. Local transforms render immediately; only remote players are interpolated. Incoming updates must include a nonnegative integer sequence. Duplicate, stale, and out-of-order remote sequences are ignored. Self echoes never overwrite local simulation. Reconnects use the new server-supplied spawn and restart outgoing sequences.

## Local physics

`TouchJoystick.tsx` displays a 156px circular joystick centered horizontally above chat when the viewport is at most 1024px wide or a coarse pointer is available. Drag outside the center dead zone to walk in any camera-relative direction. Holding outside the dead zone for one second automatically runs; centering or releasing stops movement and resets the timer. Pointer capture supports releasing outside the control. Cancellation, focus changes, page hiding, input-mode changes, and unmount clear movement and timers. Keyboard controls and the WebSocket protocol remain unchanged. `TouchMovementControls.tsx` remains in the project but is not rendered. The joystick is hidden in the dressing preview. Verify arbitrary drag directions, the dead zone, auto-run after one second, release, camera dragging with another finger, chat focus, and returning after hiding the page.

Rapier initializes once per application lifetime. World geometry is loaded once per scene and baked into static triangle colliders, preserving geometric bridge decks, stairs, walls, and genuine doorway openings. The local capsule simulates at 60 Hz independently from the maximum 20 Hz network rate. Walking speed is 2.5 units/second; running speed is 5.5. Capsule radius is 0.25 and height is 1.6, step height is 0.4, ground snap is 0.5, and maximum climb slope is 50 degrees. The character's reported position is its feet position.

Water meshes identified by river/pond/lake/moat water names or materials are sensors, never walkable ground. Footprint support checks reject entering water or unsupported drops while permitting a bridge deck above the water. Blender custom property `collision: "none"` skips a mesh or hierarchy; `collision: "water"` explicitly marks water. Solid geometry is used as authored. Closed door meshes, walls behind decorative doors, and buildings without modeled interiors remain solid; those require a world-asset change to create usable entrances. No door-opening event or building teleport has been invented.

Input is disabled until world physics is ready. Loading failures display a message instead of allowing movement without collision. Focusing chat, losing focus, or hiding the page clears movement keys. Physics worlds, controllers, render loops, scene assets, and listeners are disposed when leaving.

Leaving the world closes its connection. Players can select a different appearance before starting a new session; there is no appearance-update message during an active session. Server rejections display their code and message without automatically retrying. Transient connection failures retry with backoff.

Run automated protocol, physics, chat, and character-resource checks with:

```sh
node --test tests/multiplayer.test.mjs
```

These checks use a controlled WebSocket transport. They do not replace testing against the actual backend or checking the Blender assets visually.

## Driving the shared Cybertruck

Driving the shared Cybertruck is implemented in the frontend using the vehicle extension in `PROTOCOLS.md`. The separate backend must include `world:init.payload.vehicles` and implement the vehicle events before driving is enabled. Older servers omitting vehicles still allow walking and chat.

Approach the truck at (-35, 0, 0), then press E or tap Drive truck. Wait for the server seat grant. WASD/arrows or the touch joystick accelerate/reverse and steer relative to the vehicle; the camera orbits and follows it. Shift does not boost vehicle speed. Press E or tap Exit truck to brake and request a safe exit. If both sides are blocked, move to clear ground and try again. The standing driver model is hidden while driving.

The truck is excluded from baked static geometry and uses a reusable moving collision box for walking. Driving tests the body and four wheel support points in substeps, rejecting water, obstacles and unsupported terrain. Steep or uneven terrain is conservatively blocked; the truck remains upright without suspension simulation. Assets are reused and physics resources are released with the world.

Verify with a compatible backend: join two clients, race to enter (only one grant), observe driving and wheel spin on both, stop and exit, block both exit sides, join while occupied, disconnect the driver, and reconnect. Confirm the parked position is retained, the old spawn has no invisible truck collider, and walking/chat still work. Automated vehicle coverage is in `tests/multiplayer.test.mjs`; it does not replace a live backend/browser check.

## World chat

The bottom chat input shares the world WebSocket connection and follows `CHAT.md`. Sending is available after `world:init`; accepted messages appear only after the server echoes `chat:message`. Sender identity, message IDs, and timestamps come from the backend. The frontend keeps the latest 100 messages in timestamp order and ignores duplicate IDs. There is no message-history panel: each character displays their latest accepted message in a speech bubble above their head for six seconds. A new message replaces that character?s current bubble. Bubbles follow movement and the camera, hide off-screen, and are removed when a player leaves.

Messages are trimmed, limited to 200 Unicode code points, and locally limited to one send per second. The backend must enforce the same limits. Chat errors display without disconnecting an already joined player. Drafts are preserved through disconnections; chat controls are disabled until reconnection finishes. Focus on the chat controls clears movement input.

To verify manually, join with two tabs, send text and emoji from both, confirm each broadcast appears once in each tab, and confirm typing WASD in chat does not move a character. Test sending again within one second and restarting the backend. The backend must implement `chat:send` / `chat:message` on the configured endpoint for messages to be delivered.
