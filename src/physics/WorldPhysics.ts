import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { LocalMovement } from "../utils/movementAdapter";
import type { AnimationState, Vector3 } from "../network/protocol";

const RADIUS = 0.25;
const HALF_HEIGHT = 0.55;
const CENTER_HEIGHT = HALF_HEIGHT + RADIUS;
const STEP = 1 / 60;
let initialization: Promise<void> | undefined;

/** Initialize the shared WASM module once, including across React development remounts. */
export function initializePhysics() {
  initialization ??= RAPIER.init();
  return initialization;
}

/** Bake actual mesh triangles, preserving door openings and bridge/stair surfaces.
 * Bounding-box colliders would fill those openings and the space beneath bridges.
 */
function meshCollider(meshes: THREE.Mesh[]) {
  if (!meshes.length) return null;
  let vertexCount = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    vertexCount += mesh.geometry.getAttribute("position").count;
    indexCount += mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count;
  }
  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const point = new THREE.Vector3();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      point.toArray(vertices, (vertexOffset + i) * 3);
    }
    const count = mesh.geometry.index?.count ?? positions.count;
    const mirrored = mesh.matrixWorld.determinant() < 0;
    for (let i = 0; i < count; i += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const source = i + (mirrored && corner > 0 ? 3 - corner : corner);
        indices[indexOffset++] = vertexOffset + (mesh.geometry.index?.getX(source) ?? source);
      }
    }
    vertexOffset += positions.count;
  }
  return RAPIER.ColliderDesc.trimesh(vertices, indices);
}

/** Own the local capsule, static world and ground/water queries; no network state is mutated here. */
export class WorldPhysics {
  readonly position: Vector3 = { x: 0, y: 0, z: 0 };
  rotation = 0;
  animation: AnimationState = "Idle";
  private readonly world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  private readonly controller = this.world.createCharacterController(0.015);
  private readonly capsule = this.world.createCollider(
    RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS),
  );
  private truck: RAPIER.Collider | undefined;
  private water: RAPIER.Collider | undefined;
  private velocityY = 0;
  private accumulator = 0;

  constructor(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const solids: THREE.Mesh[] = [];
    const water: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute("position")) return;
      let parent: THREE.Object3D | null = object;
      while (parent) {
        if (
          !parent.visible ||
          parent.userData.collision === "none" ||
          /Cybertruck.*drive[_ ]control/.test(parent.name)
        )
          return;
        parent = parent.parent;
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const isWater =
        object.userData.collision === "water" ||
        /(?:river|pond|lake|moat).*water/i.test(object.name) ||
        materials.some((material) => /(?:river|pond|lake|moat).*water/i.test(material.name));
      (isWater ? water : solids).push(object);
    });
    const solidDesc = meshCollider(solids);
    if (solidDesc) this.world.createCollider(solidDesc);
    const waterDesc = meshCollider(water);
    if (waterDesc) this.water = this.world.createCollider(waterDesc.setSensor(true));
    this.controller.enableAutostep(0.4, 0.1, false);
    this.controller.enableSnapToGround(0.5);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.world.timestep = STEP;
    this.world.step();
  }

  /** Keep the authored truck out of the baked map and move a single reusable solid with it. */
  setTruck(position: Vector3, rotation: number) {
    if (!this.truck)
      this.truck = this.world.createCollider(RAPIER.ColliderDesc.cuboid(3, 1.05, 1.27));
    this.truck.setTranslation({
      x: position.x + 0.07 * Math.cos(rotation),
      y: position.y + 1.15,
      z: position.z - 0.07 * Math.sin(rotation),
    });
    this.truck.setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) });
    this.world.step();
  }

  private clearShape(
    position: Vector3,
    rotation: number,
    shape: RAPIER.Shape,
    ignoreTruck: boolean,
  ) {
    let clear = true;
    this.world.intersectionsWithShape(
      position,
      { x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) },
      shape,
      () => {
        clear = false;
        return false;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.capsule,
      undefined,
      (c) => !ignoreTruck || c.handle !== this.truck?.handle,
    );
    return clear;
  }

  /** Sample all four wheel contacts; reject water, ledges and unsupported vehicle footprints. */
  vehicleGround(position: Vector3, rotation: number): number | null {
    const heights: number[] = [];
    for (const x of [-1.77, 1.79])
      for (const z of [-1.015, 1.015]) {
        const ray = new RAPIER.Ray(
          {
            x: position.x + x * Math.cos(rotation) + z * Math.sin(rotation),
            y: position.y + 0.4,
            z: position.z - x * Math.sin(rotation) + z * Math.cos(rotation),
          },
          { x: 0, y: -1, z: 0 },
        );
        const ground = this.world.castRay(
          ray,
          1,
          false,
          RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          undefined,
          this.capsule,
          undefined,
          (c) => c.handle !== this.truck?.handle,
        );
        if (!ground) return null;
        const water = this.water?.castRay(ray, 1, false);
        if (water !== undefined && water >= 0 && water < ground.timeOfImpact - 0.01) return null;
        heights.push(ray.origin.y - ground.timeOfImpact);
      }
    if (Math.max(...heights) - Math.min(...heights) > 0.35) return null;
    return Math.max(...heights);
  }

  canDrive(position: Vector3, rotation: number) {
    return this.clearShape(
      {
        x: position.x + 0.07 * Math.cos(rotation),
        y: position.y + 1.2,
        z: position.z - 0.07 * Math.sin(rotation),
      },
      rotation,
      new RAPIER.Cuboid(3, 1.05, 1.27),
      true,
    );
  }

  /** Exit candidates use the walking capsule and require real support outside the truck. */
  findExit(position: Vector3, rotation: number): Vector3 | null {
    for (const side of [1, -1]) {
      const x = position.x + side * 2 * Math.sin(rotation);
      const z = position.z + side * 2 * Math.cos(rotation);
      const ray = new RAPIER.Ray({ x, y: position.y + 0.5, z }, { x: 0, y: -1, z: 0 });
      const ground = this.world.castRay(
        ray,
        1,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.capsule,
      );
      if (!ground) continue;
      const feet = { x, y: ray.origin.y - ground.timeOfImpact + 0.015, z };
      if (x < -70 || x > 72 || z < -70 || z > 70 || feet.y < -2 || feet.y > 25) continue;
      if (
        this.safeGround(x, feet.y, z) &&
        this.clearShape(
          { x, y: feet.y + CENTER_HEIGHT, z },
          0,
          new RAPIER.Capsule(HALF_HEIGHT, RADIUS),
          false,
        )
      )
        return feet;
    }
    return null;
  }

  /** The server supplies the initial feet position; settle onto nearby authored ground. */
  spawn(position: Vector3, rotation: number) {
    Object.assign(this.position, position);
    this.rotation = rotation;
    this.velocityY = 0;
    this.accumulator = 0;
    const ray = new RAPIER.Ray(
      { x: position.x, y: position.y + 0.5, z: position.z },
      { x: 0, y: -1, z: 0 },
    );
    const ground = this.world.castRay(
      ray,
      4,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.capsule,
    );
    if (ground) this.position.y = ray.origin.y - ground.timeOfImpact + 0.015;
    this.syncCapsule();
    this.world.step();
  }

  private syncCapsule() {
    this.capsule.setTranslation({
      x: this.position.x,
      y: this.position.y + CENTER_HEIGHT,
      z: this.position.z,
    });
  }

  private safeGround(x: number, y: number, z: number) {
    // Require majority support, tolerating narrow seams between individual bridge planks.
    // Diagonal samples avoid putting three rays on the same plank seam at once.
    let supported = 0;
    for (const [dx, dz] of [
      [0, 0],
      [RADIUS * 0.65, RADIUS * 0.65],
      [-RADIUS * 0.65, RADIUS * 0.65],
      [RADIUS * 0.65, -RADIUS * 0.65],
      [-RADIUS * 0.65, -RADIUS * 0.65],
    ]) {
      const ray = new RAPIER.Ray({ x: x + dx, y: y + 0.45, z: z + dz }, { x: 0, y: -1, z: 0 });
      const ground = this.world.castRay(
        ray,
        1.05,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.capsule,
      );
      if (!ground) continue;
      const waterDistance = this.water?.castRay(ray, 1.05, false);
      if (
        waterDistance !== undefined &&
        waterDistance >= 0 &&
        waterDistance < ground.timeOfImpact - 0.01
      )
        continue;
      supported++;
    }
    return supported >= 3;
  }

  update(input: LocalMovement, delta: number) {
    this.accumulator += Math.min(delta, 0.1);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.velocityY = Math.max(this.velocityY - 20 * STEP, -20);
      const speed = input.running ? 5.5 : 2.5;
      this.controller.computeColliderMovement(
        this.capsule,
        {
          x: input.x * speed * STEP,
          y: this.velocityY * STEP,
          z: input.z * speed * STEP,
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      );
      let movement = this.controller.computedMovement();
      if (
        !this.safeGround(
          this.position.x + movement.x,
          this.position.y + movement.y,
          this.position.z + movement.z,
        )
      ) {
        // Re-query vertical movement at the safe location instead of stepping into water or a void.
        this.controller.computeColliderMovement(
          this.capsule,
          { x: 0, y: this.velocityY * STEP, z: 0 },
          RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        );
        movement = this.controller.computedMovement();
      }
      this.position.x += movement.x;
      this.position.y += movement.y;
      this.position.z += movement.z;
      if (this.controller.computedGrounded()) this.velocityY = 0;
      const moving = Math.hypot(movement.x, movement.z) > 0.0001;
      this.animation = moving ? (input.running ? "Run" : "Walk") : "Idle";
      if (input.x || input.z) {
        const target = Math.atan2(input.x, input.z);
        const difference = Math.atan2(
          Math.sin(target - this.rotation),
          Math.cos(target - this.rotation),
        );
        this.rotation += difference * (1 - Math.exp(-15 * STEP));
        if (Math.abs(difference) < 0.0001) this.rotation = target;
      }
      this.syncCapsule();
      this.world.step();
    }
  }

  dispose() {
    this.world.removeCharacterController(this.controller);
    this.world.free();
  }
}
