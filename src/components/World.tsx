import { useCallback, useEffect, useRef, useState } from "react";
import TouchJoystick, { type JoystickInput } from "./TouchJoystick";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyAppearance, type Appearance } from "../utils/appearance";
import { MultiplayerSession, type ConnectionStatus } from "../network/MultiplayerSession";
import { NetworkCharacters } from "./NetworkCharacters";
import { CharacterChatBubbles } from "./CharacterChatBubbles";
import { adaptMovementInput } from "../utils/movementAdapter";
import { initializePhysics, WorldPhysics } from "../physics/WorldPhysics";

import { VehicleController } from "../vehicles/VehicleController";

type MovementState = "Idle" | "Walk" | "Run";
/** Release GPU resources, collecting shared assets in sets to avoid disposing them repeatedly. */
function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
    // Skeletons allocate animation data separately from geometry and materials.
    if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

export default function World({
  appearance,
  preview = false,
  name = "Player",
  onStatus,
  onSession,
}: {
  appearance: Appearance;
  preview?: boolean;
  name?: string;
  onStatus?: (status: ConnectionStatus) => void;
  onSession?: (session: MultiplayerSession | null) => void;
}) {
  // Refs keep mutable scene objects available without triggering React renders each frame.
  const [worldMessage, setWorldMessage] = useState<string | null>(
    preview ? null : "Loading world physics...",
  );
  const vehicleButtonRef = useRef<HTMLButtonElement>(null);
  const vehicleStatusRef = useRef<HTMLDivElement>(null);
  const interactRef = useRef<() => void>(() => {});
  const containerRef = useRef<HTMLDivElement>(null);
  const characterRef = useRef<THREE.Object3D | null>(null);
  const touchInput = useRef<JoystickInput>({ forward: 0, right: 0, running: false });
  const onTouchMovement = useCallback((input: JoystickInput) => {
    touchInput.current = input;
  }, []);
  // Async loading needs the latest choices even if they change during the download.
  const appearanceRef = useRef(appearance);
  // Update the existing model directly instead of rebuilding the scene for each selection.
  useEffect(() => {
    appearanceRef.current = appearance;
    if (characterRef.current) applyAppearance(characterRef.current, appearance);
  }, [appearance]);

  const statusRef = useRef(onStatus);
  const sessionCallbackRef = useRef(onSession);
  useEffect(() => {
    sessionCallbackRef.current = onSession;
  }, [onSession]);
  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);

  // Appearance edits update the preview directly; a different player or mode owns a new scene.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const session = preview
      ? null
      : new MultiplayerSession(
          import.meta.env.VITE_WS_URL ||
            (location.protocol === "https:"
              ? "wss://" + location.host + "/"
              : "ws://localhost:3000/"),
          name,
          { ...appearanceRef.current },
          (status) => statusRef.current?.(status),
        );
    session?.start();
    sessionCallbackRef.current?.(session);
    let networkCharacters: NetworkCharacters | undefined;
    let physics: WorldPhysics | undefined;
    let vehicleController: VehicleController | undefined;
    let releaseVersion = 0;
    interactRef.current = () => {
      if (session && physics && vehicleController) vehicleController.interact(session, physics);
    };
    let simulatedPlayerId: string | null = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(preview ? 0xe8eee9 : 0x87ceeb);
    // Match the panel aspect ratio; near/far define the camera depth range.
    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.1,
      1000,
    );
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    // Cap high-density rendering resolution to limit GPU cost.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Ambient light fills dark areas; directional light gives surfaces visible shape.
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const sunlight = new THREE.DirectionalLight(0xffffff, 3);
    sunlight.position.set(20, 50, 20);
    scene.add(sunlight);

    // Orbit around the player, restricting zoom and angles to keep the camera above ground.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 3;
    controls.maxDistance = 16;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    // Only the player and camera move; the imported world stays at its authored transform.
    const player = new THREE.Group();
    player.position.set(0, 0, preview ? 0 : 23.55);
    scene.add(player);
    controls.target.copy(player.position).add(new THREE.Vector3(0, 1.2, 0));
    camera.position.copy(controls.target).add(new THREE.Vector3(0, 3.5, 6));
    // Frame the character more closely in the dressing room.
    if (preview) {
      controls.minDistance = 2;
      controls.target.set(0, 0.95, 0);
      camera.position.set(0, 1.5, 3.5);
    }
    controls.update();
    const chatBubbles = session ? new CharacterChatBubbles(container, session) : null;

    // Remember held keys so movement is independent of keyboard repeat events.
    const keys = new Set<string>();
    const inputCodes = new Set([
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowLeft",
      "ArrowDown",
      "ArrowRight",
      "ShiftLeft",
      "ShiftRight",
    ]);
    const onKeyDown = (event: KeyboardEvent) => {
      if (preview) return;
      // Leave keyboard input alone while the user is editing a field.
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))
      )
        return;
      if (event.code === "KeyE" && !event.repeat) {
        event.preventDefault();
        interactRef.current();
      }
      if (inputCodes.has(event.code)) {
        event.preventDefault();
        keys.add(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };
    // Focus changes can hide keyup events; clear input to prevent stuck movement.
    const clearKeys = () => {
      keys.clear();
      touchInput.current = { forward: 0, right: 0, running: false };
      if (
        physics &&
        session?.playerId &&
        !session.driving &&
        simulatedPlayerId === session.playerId
      ) {
        physics.animation = "Idle";
        session.setMovement({
          position: physics.position,
          rotation: physics.rotation,
          animation: "Idle",
        });
      }
    };
    // Focusing chat while a movement key is held must stop that previous input too.
    const onFocus = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))
      )
        clearKeys();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);
    document.addEventListener("visibilitychange", clearKeys);
    document.addEventListener("focusin", onFocus);

    // Loads can finish after unmount; callbacks must then release their downloaded models.
    let disposed = false;
    let character: THREE.Object3D | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    let activeState: MovementState | undefined;
    const actions: Partial<Record<MovementState, THREE.AnimationAction>> = {};
    // Blend clips over 0.2 seconds, restarting only when the movement state changes.
    const setAnimation = (state: MovementState) => {
      if (state === activeState || !actions[state]) return;
      if (activeState) actions[activeState]?.fadeOut(0.2);
      actions[state]!.reset().fadeIn(0.2).play();
      activeState = state;
    };

    const loader = new GLTFLoader();
    if (!preview)
      loader.load(
        "/models/osaka-castle2.glb",
        (gltf) => {
          if (disposed) {
            disposeModel(gltf.scene);
            return;
          }
          scene.add(gltf.scene);
          void initializePhysics()
            .then(() => {
              if (disposed) return;
              physics = new WorldPhysics(gltf.scene);
              vehicleController = new VehicleController(gltf.scene);
              const initialPosition = vehicleController.root.getWorldPosition(new THREE.Vector3());
              physics.setTruck(
                initialPosition,
                new THREE.Euler().setFromQuaternion(
                  vehicleController.root.getWorldQuaternion(new THREE.Quaternion()),
                  "YXZ",
                ).y,
              );
              setWorldMessage(null);
            })
            .catch((error: unknown) => {
              console.error("Physics initialization failed:", error);
              if (!disposed)
                setWorldMessage("World physics could not load. Please reload to try again.");
            });
        },
        undefined,
        (error) => {
          console.error("World load error:", error);
          if (!disposed) setWorldMessage("World could not load. Please reload to try again.");
        },
      );

    loader.load(
      "/models/character2.glb",
      (gltf) => {
        if (disposed) {
          disposeModel(gltf.scene);
          return;
        }
        character = gltf.scene;
        if (!preview) {
          networkCharacters = new NetworkCharacters(scene, character, gltf.animations);
          return;
        }
        characterRef.current = character;
        applyAppearance(character, appearanceRef.current);
        player.add(character);
        mixer = new THREE.AnimationMixer(character);
        // Find Blender clips regardless of capitalization; missing clips are reported.
        for (const state of ["Idle", "Walk", "Run"] as const) {
          const clip = gltf.animations.find(
            (clip) => clip.name.toLowerCase() === state.toLowerCase(),
          );
          if (clip) actions[state] = mixer.clipAction(clip);
          else console.warn(`Character animation missing: ${state}`);
        }
        setAnimation("Idle");
      },
      undefined,
      (error) => console.error("Character load error:", error),
    );

    // CSS can resize this panel without resizing the browser window.
    const resizeObserver = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = container;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(container);

    // Reuse these math objects in the loop to reduce temporary allocations.
    const clock = new THREE.Clock();
    const previousPosition = new THREE.Vector3();
    const displacement = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const viewDirection = new THREE.Vector3();

    renderer.setAnimationLoop(() => {
      // Limit elapsed time after pauses to prevent a large movement jump.
      const delta = Math.min(clock.getDelta(), 0.05);
      previousPosition.copy(player.position);
      if (session) {
        const forward =
          Number(keys.has("KeyW") || keys.has("ArrowUp")) -
          Number(keys.has("KeyS") || keys.has("ArrowDown")) +
          touchInput.current.forward;
        const right =
          Number(keys.has("KeyD") || keys.has("ArrowRight")) -
          Number(keys.has("KeyA") || keys.has("ArrowLeft")) +
          touchInput.current.right;
        camera.getWorldDirection(viewDirection);
        if (physics && session.playerId && networkCharacters) {
          const local = session.players.get(session.playerId);
          if (
            local &&
            (simulatedPlayerId !== session.playerId || releaseVersion !== session.releaseVersion)
          ) {
            releaseVersion = session.releaseVersion;
            physics.spawn(local.position, local.rotation);
            simulatedPlayerId = session.playerId;
          }
          if (local && !session.driving) {
            physics.update(
              adaptMovementInput(
                forward,
                right,
                keys.has("ShiftLeft") || keys.has("ShiftRight") || touchInput.current.running,
                viewDirection,
              ),
              delta,
            );
            session.setMovement({
              position: physics.position,
              rotation: physics.rotation,
              animation: physics.animation,
            });
          }
        }
        if (physics) vehicleController?.update(session, physics, forward, right, delta);
        if (!session.playerId) simulatedPlayerId = null;
        networkCharacters?.update(session.players, delta, session.playerId);
        const own = session.playerId ? networkCharacters?.objects.get(session.playerId) : undefined;
        if (own) player.position.copy(own.position);
        for (const [id, object] of networkCharacters?.objects ?? [])
          object.visible = id !== session.vehicle?.driverId;
        if (session.driving && vehicleController?.position)
          player.position.copy(vehicleController.position);
        const v = session.vehicle;
        const near =
          !!v &&
          !!physics &&
          Math.hypot(
            physics.position.x - v.position.x,
            physics.position.y - v.position.y,
            physics.position.z - v.position.z,
          ) <= 3;
        if (vehicleButtonRef.current) {
          vehicleButtonRef.current.hidden = !session.driving && !near;
          vehicleButtonRef.current.disabled =
            session.vehiclePending || (!!v?.driverId && !session.driving);
          vehicleButtonRef.current.textContent = session.vehiclePending
            ? "Waiting for server..."
            : session.driving
              ? "Exit truck (E)"
              : v?.driverId
                ? "Truck occupied"
                : "Drive truck (E)";
        }
        if (vehicleStatusRef.current)
          vehicleStatusRef.current.textContent = session.vehicleError ?? "";
      }
      // Keep idle and preview animations advancing even when the player is not moving.
      mixer?.update(delta);
      // Shift the camera by the player movement to preserve the current orbit offset.
      displacement.subVectors(player.position, previousPosition);
      camera.position.add(displacement);
      controls.target.copy(player.position).addScaledVector(up, preview ? 0.95 : 1.2);
      controls.update();
      if (networkCharacters) chatBubbles?.update(camera, networkCharacters.objects);
      renderer.render(scene, camera);
    });

    // Release everything this effect owns, including during StrictMode remounts.
    // Stop rendering before disposing GPU resources to avoid using released assets.
    return () => {
      disposed = true;
      interactRef.current = () => {};
      session?.stop();
      chatBubbles?.dispose();
      sessionCallbackRef.current?.(null);
      networkCharacters?.dispose();
      physics?.dispose();
      characterRef.current = null;
      touchInput.current = { forward: 0, right: 0, running: false };
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
      document.removeEventListener("visibilitychange", clearKeys);
      document.removeEventListener("focusin", onFocus);
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      mixer?.stopAllAction();
      if (character) mixer?.uncacheRoot(character);
      controls.dispose();
      disposeModel(scene);
      if (!preview && character) disposeModel(character);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [preview, name]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative" }} />
      {!preview && <TouchJoystick onChange={onTouchMovement} />}
      {!preview && (
        <div className="absolute left-3 top-36 z-10">
          <button
            ref={vehicleButtonRef}
            hidden
            onClick={(event) => {
              interactRef.current();
              event.currentTarget.blur();
            }}
            className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
          >
            Drive truck (E)
          </button>
          <div
            ref={vehicleStatusRef}
            role="status"
            className="mt-2 max-w-sm rounded bg-white/90 px-2 text-sm text-slate-900"
          />
        </div>
      )}
      {worldMessage && (
        <div
          role="status"
          className="absolute inset-x-3 top-24 rounded bg-white/95 p-3 text-center"
        >
          {worldMessage}
        </div>
      )}
      {/* Ignore pointer events on the instructions so dragging still reaches the canvas. */}
      <div
        className={preview ? undefined : "world-keyboard-hint"}
        style={{
          position: "absolute",
          bottom: preview ? 20 : 120,
          left: 20,
          padding: "10px 14px",
          borderRadius: 8,
          background: "#0009",
          color: "white",
          pointerEvents: "none",
          fontSize: 14,
        }}
      >
        {preview
          ? "Drag: Rotate  Scroll: Zoom"
          : "WASD / Arrows: Move / Drive  Shift: Run  E: Enter / Exit truck  Drag: Look"}
      </div>
    </div>
  );
}
