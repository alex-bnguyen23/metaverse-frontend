# AGENTS.md

## Project Stack

- React
- TypeScript
- Three.js
- Vite
- Blender (GLB/GLTF models)
- TailwindCSS
- WebSocket (native browser API)
- Node.js multiplayer backend (separate project)

## Project Overview

This is a browser-based 3D multiplayer game.

- One shared world for all players.
- Maximum **5 concurrent players**.
- The world and character models are created in Blender and loaded using Three.js.
- Players customize their appearance before entering the world.
- All players can see each other's characters, positions, rotations, and animations.
- The backend manages authoritative player states and multiplayer synchronization.
- The frontend handles rendering, player input, and smooth character movement.

## Working Directory Restrictions (CRITICAL)

- **ONLY work within the current project directory and its subdirectories.**
- **NEVER read, create, modify, move, or delete files outside the current project directory.**
- Do not access parent directories (`../`), sibling projects, or unrelated folders.
- Do not execute commands that modify files outside the current project directory.
- Do not change the working directory to a location outside the project.
- Treat the current project directory as the strict workspace boundary.
- If a task requires accessing files outside this directory, **STOP and ask for explicit user permission first.**
- These restrictions apply to all tasks, including reading documentation, running scripts, installing dependencies, and using external tools.

## Coding Rules

- Write clean, readable, and maintainable TypeScript.
- Use functional React components and hooks.
- Avoid `any` and unnecessary code duplication.
- Keep components and functions small.
- Follow the existing project structure.
- Avoid unnecessary dependencies.
- Separate rendering, game logic, and WebSocket communication.
- Clean up Three.js resources, event listeners, WebSocket connections, and animation loops.
- Do not recreate GLB models unnecessarily.
- Avoid unnecessary React re-renders during the animation loop.

## Multiplayer Rules

- Connect to the backend using WebSocket.
- Support only one shared multiplayer room.
- Maximum 5 players, including the local player.
- The backend is responsible for enforcing the player limit.
- Never create additional rooms unless explicitly requested.
- Treat the server as authoritative for player positions and game state.
- Do not trust client-side positions as final authoritative positions.
- Handle WebSocket connection failures, disconnections, and reconnections.
- Prevent duplicate player objects when receiving repeated network messages.
- Remove disconnected players from the Three.js scene.
- Never send GLB files, textures, or world geometry through WebSocket.

## Player Appearance Rules

Players customize their character **only once before joining the world**.

```ts
type Appearance = {
  shirt: 0 | 1 | 2;
  pants: 0 | 1;
  hairstyle: 0 | 1;
  glasses: 0 | 1;
};
```

- Allow players to select appearance before joining.
- Send appearance data in the `player:join` event.
- Do not allow appearance changes after joining.
- Do not implement an in-game appearance update event.
- Store the selected appearance for the current session.
- Apply appearance to the local character.
- Apply received appearance to remote player characters.
- Do not repeatedly synchronize appearance during movement.
- Reuse the same character model and apply appearance variations locally.

## WebSocket Events

Use these events consistently with the backend:

| Event | Direction | Purpose |
|---|---|---|
| `player:join` | Client → Server | Submit player name and appearance |
| `world:init` | Server → Client | Receive own ID and existing players |
| `player:joined` | Server → Client | Add a new remote player |
| `player:input` | Client → Server | Send movement input |
| `player:update` | Server → Client | Synchronize player movement |
| `player:left` | Server → Client | Remove disconnected player |

- Keep WebSocket message types strongly typed.
- Validate incoming message structures.
- Use a single WebSocket connection per player session.
- Do not send movement messages when unnecessary.
- Do not create a separate WebSocket connection for every character.
- Match the backend's actual message protocol; do not invent incompatible payloads.

## Player Movement and Animation

- The local player is controlled using keyboard input.
- Send movement input to the server rather than trusting local position changes.
- Use client-side prediction when necessary for responsive movement.
- Reconcile predicted positions with authoritative server updates.
- Interpolate remote player positions and rotations for smooth movement.
- Synchronize `Idle`, `Walk`, and `Run` animation states.
- Do not restart an animation if it is already playing.
- Keep movement and animations independent of React rendering.
- Prevent characters from moving through walls, buildings, and other solid obstacles.
- Coordinate collision logic with the backend to prevent position desynchronization.

## Game Loop

- Use `requestAnimationFrame` for frontend rendering.
- Keep frontend rendering independent of server tick rate.
- Assume an initial server simulation rate of 20 ticks per second, unless the backend specifies otherwise.
- Use delta time for frame-independent movement and animation.
- Avoid sending WebSocket messages on every rendered frame.
- Clean up animation frames and listeners when components unmount.

## Three.js Rules

- Load the Blender world GLB once.
- Load and reuse character assets efficiently.
- Create one character instance per connected player.
- Maintain a `Map<string, THREE.Object3D>` for player objects.
- Keep remote player state separate from React UI state when appropriate.
- Properly dispose of unused geometries, materials, and textures.
- Avoid disposing shared assets while other players still use them.
- Update character transforms directly in the Three.js animation loop.

## Comment Rules

- Write clear, professional English comments.
- Explain **why** code exists, not what obvious code does.
- Use JSDoc for complex functions and reusable utilities.
- Comment multiplayer synchronization, interpolation, collision logic, and WebSocket lifecycle handling.
- Explain complicated calculations and workarounds.
- Avoid excessive, redundant, or outdated comments.
- Update comments when changing related code.

## Prettier Rules

- **Always run Prettier after modifying code.**
- Follow the existing `.prettierrc` configuration.
- Format only modified files when possible.
- Never leave modified code unformatted.

```bash
npx prettier --write <modified-files>
```

## Before Finishing

1. Review modified code.
2. Run Prettier.
3. Run TypeScript and ESLint checks when available.
4. Fix errors introduced by the changes.
5. Verify multiplayer changes remain compatible with the backend protocol.
6. Check WebSocket and Three.js resource cleanup.
7. Briefly summarize what changed and which checks passed.

**Important:** Never claim formatting or tests passed unless they were actually executed.

## Documentation Rules (IMPORTANT)

- **Always read and follow the relevant documentation in the `docs/` folder before writing or modifying code.**
- Treat `docs/` as the source of truth for project architecture, protocols, and data structures.
- **Always write new instructions, specifications, and technical documentation in the `docs/` folder.**
- Update existing documentation whenever related code changes.
- Keep all documentation clear, accurate, and up to date.