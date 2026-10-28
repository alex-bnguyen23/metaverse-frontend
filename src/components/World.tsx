import { useCallback, useEffect, useRef } from "react";
import TouchJoystick, { type JoystickInput } from "./TouchJoystick";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import dracoWrapperUrl from "three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url";
import dracoWasmUrl from "three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyAppearance, type Appearance } from "../utils/appearance";
import { MultiplayerSession, type ConnectionStatus } from "../network/MultiplayerSession";
import {
  NetworkCharacters,
  characterAssets,
  characterClips,
  normalizeCharacter,
  movementClip,
} from "./NetworkCharacters";
import { CharacterChatBubbles } from "./CharacterChatBubbles";
import { adaptMovementInput } from "../utils/movementAdapter";
import { initializePhysics, WorldPhysics } from "../physics/WorldPhysics";

import { VehicleController } from "../vehicles/VehicleController";
import { FramePictures } from "./FramePictures";
import { GardenDancer } from "./GardenDancer";
import { Notification } from "../utils/notifications";

import type { CharacterModel } from "../network/protocol";

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
  model = "custom",
  preview = false,
  name = "Player",
  onStatus,
  onSession,
}: {
  appearance: Appearance;
  model?: CharacterModel;
  preview?: boolean;
  name?: string;
  onStatus?: (status: ConnectionStatus) => void;
  onSession?: (session: MultiplayerSession | null) => void;
}) {
  // Refs keep mutable scene objects available without triggering React renders each frame.
  const vehicleButtonRef = useRef<HTMLButtonElement>(null);
  const vehicleRoleRef = useRef<HTMLDivElement>(null);
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
    if (characterRef.current && model === "custom")
      applyAppearance(characterRef.current, appearance);
  }, [appearance, model]);

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
          model === "custom"
            ? { model, appearance: { ...appearanceRef.current } }
            : { model, appearance: null },
          (status) => statusRef.current?.(status),
        );
    session?.start();
    sessionCallbackRef.current?.(session);
    let networkCharacters: NetworkCharacters | undefined;
    let physics: WorldPhysics | undefined;
    let vehicleController: VehicleController | undefined;
    let framePictures: FramePictures | undefined;
    const worldNotification = new Notification();
    const vehicleNotification = new Notification();
    let previousVehicleError: string | null = null;
    if (!preview) worldNotification.show("Loading world physics...", "info", true);
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
        !session.inVehicle &&
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
    const playerTemplates: THREE.Object3D[] = [];
    let mixer: THREE.AnimationMixer | undefined;
    let gateCharacter: THREE.Object3D | undefined;
    let gateMixer: THREE.AnimationMixer | undefined;
    const gardenDancers: GardenDancer[] = [];
    let activeState: MovementState | undefined;
    const actions: Partial<Record<MovementState, THREE.AnimationAction>> = {};
    // Blend clips over 0.2 seconds, restarting only when the movement state changes.
    const setAnimation = (state: MovementState) => {
      if (state === activeState || !actions[state]) return;
      if (activeState) actions[activeState]?.fadeOut(0.2);
      actions[state]!.reset().fadeIn(0.2).play();
      activeState = state;
    };

    // Bundle matching decoder assets locally so compressed Blender exports load in production too.
    const dracoLoader = new DRACOLoader().setDecoderPath({
      js: dracoWrapperUrl,
      wasm: dracoWasmUrl,
    });
    const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
    if (!preview)
      loader.load(
        "/models/osaka-castle.glb",
        (gltf) => {
          if (disposed) {
            disposeModel(gltf.scene);
            return;
          }
          scene.add(gltf.scene);
          const gardenBench = gltf.scene.getObjectByName("Garden_Bench_1_Seat_Slat_2");
          if (gardenBench) {
            const gardenPosition = gardenBench.getWorldPosition(new THREE.Vector3());
            const dances = [
              { model: "person1", clips: ["All_Night_Dance", "Breakdance_1990"], offset: -2 },
              { model: "person2", clips: ["dance_05", "dance_02"], offset: 3 },
            ];
            for (const dance of dances) {
              loader.load(
                `/models/${dance.model}.glb`,
                (model) => {
                  if (disposed) {
                    disposeModel(model.scene);
                    return;
                  }
                  const clips = dance.clips.map((name) =>
                    model.animations.find((clip) => clip.name === name),
                  );
                  if (clips.some((clip) => !clip)) {
                    console.warn(`Garden dance clips missing for ${dance.model}.`);
                    disposeModel(model.scene);
                    return;
                  }
                  // Keep both performers clear of the bench and the central castle stairs.
                  model.scene.position.set(
                    gardenPosition.x + 3,
                    0.05,
                    gardenPosition.z + dance.offset,
                  );
                  if (dance.model === "person2") model.scene.scale.multiplyScalar(2);
                  scene.add(model.scene);
                  gardenDancers.push(
                    new GardenDancer(
                      model.scene,
                      clips.filter((clip) => clip !== undefined),
                    ),
                  );
                },
                undefined,
                (error) => console.error(`Garden ${dance.model} load error:`, error),
              );
            }
          } else console.warn("Castle garden bench anchor missing; dancers were not placed.");
          const gate = gltf.scene.getObjectByName("Gateway_Gold_Lintel");
          const approach = gltf.scene.getObjectByName("Gateway_Approach_Path");
          if (gate && approach) {
            const gatePosition = gate.getWorldPosition(new THREE.Vector3());
            const groundHeight = new THREE.Box3().setFromObject(approach).max.y;
            loader.load(
              "/models/ceo-character.glb",
              (ceo) => {
                if (disposed) {
                  disposeModel(ceo.scene);
                  return;
                }
                const clip = ceo.animations.find((animation) => animation.name === "Agree_Gesture");
                if (!clip) {
                  console.warn("CEO animation missing: Agree_Gesture");
                  disposeModel(ceo.scene);
                  return;
                }
                gateCharacter = ceo.scene;
                // Stand beside the opening, facing the village along the positive Z axis.
                gateCharacter.position.set(
                  gatePosition.x + 1.8,
                  groundHeight,
                  gatePosition.z + 1.2,
                );
                scene.add(gateCharacter);
                gateMixer = new THREE.AnimationMixer(gateCharacter);
                gateMixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
              },
              undefined,
              (error) => console.error("Gate CEO load error:", error),
            );
          } else console.warn("Castle main gateway anchors missing; CEO was not placed.");
          framePictures = new FramePictures(gltf.scene, container);
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
              worldNotification.dismiss();
            })
            .catch((error: unknown) => {
              console.error("Physics initialization failed:", error);
              if (!disposed)
                worldNotification.show(
                  "World physics could not load. Please reload to try again.",
                  "error",
                );
            });
        },
        undefined,
        (error) => {
          console.error("World load error:", error);
          if (!disposed)
            worldNotification.show("World could not load. Please reload to try again.", "error");
        },
      );

    loader.load(
      preview ? characterAssets[model] : characterAssets.custom,
      (gltf) => {
        if (disposed) {
          disposeModel(gltf.scene);
          return;
        }
        character = gltf.scene;
        if (!preview) {
          networkCharacters = new NetworkCharacters(scene, character, gltf.animations);
          for (const fixed of ["person2", "person3", "ceo"] as const) {
            loader.load(
              characterAssets[fixed],
              (asset) => {
                if (disposed) {
                  disposeModel(asset.scene);
                  return;
                }
                playerTemplates.push(asset.scene);
                networkCharacters?.addTemplate(fixed, asset.scene, asset.animations);
              },
              undefined,
              (error) => {
                console.error("Player model load error:", fixed, error);
                if (!disposed)
                  worldNotification.show(
                    "A player character could not load. Please reload to try again.",
                    "error",
                  );
              },
            );
          }
          return;
        }
        characterRef.current = character;
        if (model === "custom") applyAppearance(character, appearanceRef.current);
        player.add(normalizeCharacter(character));
        mixer = new THREE.AnimationMixer(character);
        // Each model maps semantic movement states to its authored clip names.
        for (const state of ["Idle", "Walk", "Run"] as const) {
          const clip = gltf.animations.find((clip) => clip.name === characterClips[model][state]);
          if (clip) actions[state] = mixer.clipAction(movementClip(clip, character));
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
          if (local && !session.inVehicle) {
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
          object.visible = id !== session.vehicle?.driverId && id !== session.vehicle?.passengerId;
        if (session.inVehicle && vehicleController?.position)
          player.position.copy(vehicleController.position);
        const v = session.vehicle;
        const roleBadge = vehicleRoleRef.current;
        if (roleBadge) {
          const label = session.driving
            ? "You are the driver"
            : session.passenger
              ? "You are a passenger"
              : "";
          // Update only on seat transitions so the live region stays quiet during movement.
          if (roleBadge.textContent !== label) roleBadge.textContent = label;
          roleBadge.hidden = !session.inVehicle;
        }
        const near =
          !!v &&
          !!physics &&
          Math.hypot(
            physics.position.x - v.position.x,
            physics.position.y - v.position.y,
            physics.position.z - v.position.z,
          ) <= 3;
        if (vehicleButtonRef.current) {
          vehicleButtonRef.current.hidden = !session.inVehicle && !near;
          vehicleButtonRef.current.disabled =
            session.vehiclePending ||
            (!session.inVehicle && ((!!v?.driverId && !!v?.passengerId) || v?.speed !== 0));
          vehicleButtonRef.current.textContent = session.vehiclePending
            ? "Waiting for server..."
            : session.inVehicle
              ? "Exit truck (E)"
              : v?.driverId
                ? v.passengerId
                  ? "Truck full"
                  : "Ride as passenger (E)"
                : "Drive truck (E)";
        }
        // Report transitions only; the render loop must not create repeated toasts.
        if (session.vehicleError !== previousVehicleError) {
          previousVehicleError = session.vehicleError;
          if (session.vehicleError) vehicleNotification.show(session.vehicleError, "error");
          else vehicleNotification.dismiss();
        }
      }
      // Keep idle and preview animations advancing even when the player is not moving.
      mixer?.update(delta);
      gateMixer?.update(delta);
      for (const dancer of gardenDancers) dancer.update(delta);
      // Shift the camera by the player movement to preserve the current orbit offset.
      displacement.subVectors(player.position, previousPosition);
      camera.position.add(displacement);
      controls.target.copy(player.position).addScaledVector(up, preview ? 0.95 : 1.2);
      controls.update();
      if (networkCharacters) chatBubbles?.update(camera, networkCharacters.objects);
      framePictures?.update(camera, container.clientWidth, container.clientHeight);
      renderer.render(scene, camera);
    });

    // Release everything this effect owns, including during StrictMode remounts.
    // Stop rendering before disposing GPU resources to avoid using released assets.
    return () => {
      disposed = true;
      worldNotification.dismiss();
      vehicleNotification.dismiss();
      interactRef.current = () => {};
      session?.stop();
      chatBubbles?.dispose();
      framePictures?.dispose();
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
      gateMixer?.stopAllAction();
      if (gateCharacter) gateMixer?.uncacheRoot(gateCharacter);
      for (const dancer of gardenDancers) dancer.dispose();
      controls.dispose();
      dracoLoader.dispose();
      disposeModel(scene);
      if (!preview && character) disposeModel(character);
      for (const template of playerTemplates) disposeModel(template);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [preview, name, model]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative" }} />
      {!preview && <TouchJoystick onChange={onTouchMovement} />}
      {!preview && (
        <div className="absolute left-3 top-36 z-10">
          <div
            ref={vehicleRoleRef}
            hidden
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="pointer-events-none mb-2 w-fit rounded border border-amber-300/50 bg-slate-900 px-4 py-2 text-sm font-semibold text-amber-200 shadow-lg"
          />
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
          fontSize: 11,
        }}
      >
        {preview
          ? "Drag: Rotate  Scroll: Zoom"
          : "WASD / Arrows: Move / Drive  Shift: Run E: Enter / Exit truck  Drag: Look"}
      </div>
    </div>
  );
}
