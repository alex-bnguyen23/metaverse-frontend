import * as THREE from "three";
import type { VehicleState } from "../network/protocol";
import type { MultiplayerSession } from "../network/MultiplayerSession";
import type { WorldPhysics } from "../physics/WorldPhysics";

export const VEHICLE_CONFIG = {
  minSpeed: -4,
  maxSpeed: 10,
  maxSteering: Math.PI / 6,
  wheelbase: 3.56,
  wheelRadius: 0.572,
  acceleration: 8,
  braking: 16,
  drag: 5,
};

/** Own the existing GLB truck, local driving prediction and remote interpolation. */
export class VehicleController {
  readonly root: THREE.Object3D;
  private readonly wheels: THREE.Object3D[] = [];
  private displayed: VehicleState | null = null;
  private revision = -1;
  private exiting = false;
  private readonly target = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly parentQuaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly axle = new THREE.Vector3(0, 0, 1);

  constructor(world: THREE.Object3D) {
    let root: THREE.Object3D | undefined;
    world.traverse((object) => {
      if (/Cybertruck.*drive[_ ]control/.test(object.name)) root = object;
      if (/wheel[_ ]spin/.test(object.name)) this.wheels.push(object);
    });
    if (!root || this.wheels.length !== 4)
      throw new Error("Cybertruck pivots are missing from the world asset.");
    this.root = root;
  }

  interact(session: MultiplayerSession, physics: WorldPhysics) {
    if (session.vehiclePending) return;
    const v = session.vehicle;
    if (!v) return;
    if (session.driving) {
      this.exiting = true;
      return;
    }
    if (v.driverId) {
      session.vehicleError = "The truck already has a driver.";
      return;
    }
    if (
      Math.hypot(
        physics.position.x - v.position.x,
        physics.position.y - v.position.y,
        physics.position.z - v.position.z,
      ) > 3
    ) {
      session.vehicleError = "Move closer to the truck to enter.";
      return;
    }
    session.requestEnter();
  }

  update(
    session: MultiplayerSession,
    physics: WorldPhysics,
    forward: number,
    right: number,
    delta: number,
  ) {
    const state = session.vehicle;
    if (!state) {
      this.displayed = null;
      this.exiting = false;
      return;
    }
    if (!this.displayed || this.revision !== state.revision) {
      this.displayed = { ...state, position: { ...state.position } };
      this.revision = state.revision;
      this.exiting = false;
    }
    const v = this.displayed;
    // Freeze the stopped prediction while waiting for its acknowledgement and the exit grant.
    if (session.driving && session.vehiclePending) {
      this.apply(v);
      physics.setTruck(v.position, v.rotation);
      return;
    }
    if (session.driving) {
      // Small substeps bound translation and rotation tests, including long rendered frames.
      let remaining = Math.min(delta, 0.05);
      while (remaining > 0) {
        const dt = Math.min(remaining, 1 / 120);
        remaining -= dt;
        const throttle =
          this.exiting || session.vehiclePending ? 0 : THREE.MathUtils.clamp(forward, -1, 1);
        const braking =
          this.exiting ||
          session.vehiclePending ||
          (throttle !== 0 && Math.sign(throttle) !== Math.sign(v.speed) && v.speed !== 0);
        if (braking || throttle === 0) {
          const amount = (braking ? VEHICLE_CONFIG.braking : VEHICLE_CONFIG.drag) * dt;
          v.speed = Math.sign(v.speed) * Math.max(0, Math.abs(v.speed) - amount) || 0;
        } else
          v.speed = THREE.MathUtils.clamp(
            v.speed + throttle * VEHICLE_CONFIG.acceleration * dt,
            VEHICLE_CONFIG.minSpeed,
            VEHICLE_CONFIG.maxSpeed,
          );
        const targetSteering =
          this.exiting || session.vehiclePending
            ? 0
            : -THREE.MathUtils.clamp(right, -1, 1) * VEHICLE_CONFIG.maxSteering;
        v.steering = THREE.MathUtils.damp(v.steering, targetSteering, 10, dt);
        if (Math.abs(v.steering - targetSteering) < 0.0001) v.steering = targetSteering;
        const rotation =
          v.rotation + (v.speed / VEHICLE_CONFIG.wheelbase) * Math.tan(v.steering) * dt;
        const distance = v.speed * dt;
        const position = {
          x: v.position.x - Math.cos(rotation) * distance,
          y: v.position.y,
          z: v.position.z + Math.sin(rotation) * distance,
        };
        const y = physics.vehicleGround(position, rotation);
        if (y !== null) position.y = y;
        if (
          y === null ||
          position.x < -70 ||
          position.x > 72 ||
          position.z < -70 ||
          position.z > 70 ||
          position.y < -2 ||
          position.y > 25 ||
          !physics.canDrive(position, rotation)
        ) {
          v.speed = 0;
        } else {
          v.position = position;
          v.rotation = Math.atan2(Math.sin(rotation), Math.cos(rotation));
          v.wheelAngle += distance / VEHICLE_CONFIG.wheelRadius;
        }
      }
      session.setVehicleMovement(v);
      if (this.exiting && v.speed === 0 && !session.vehiclePending) {
        const exit = physics.findExit(v.position, v.rotation);
        if (exit) this.exiting = !session.requestExit(exit, v.rotation);
        else {
          session.vehicleError = "No safe place to exit. Move the truck to clear ground.";
          this.exiting = false;
        }
      }
    } else {
      const blend = 1 - Math.exp(-15 * delta);
      v.position.x = THREE.MathUtils.lerp(v.position.x, state.position.x, blend);
      v.position.y = THREE.MathUtils.lerp(v.position.y, state.position.y, blend);
      v.position.z = THREE.MathUtils.lerp(v.position.z, state.position.z, blend);
      v.rotation +=
        Math.atan2(Math.sin(state.rotation - v.rotation), Math.cos(state.rotation - v.rotation)) *
        blend;
      v.wheelAngle = THREE.MathUtils.lerp(v.wheelAngle, state.wheelAngle, blend);
      v.steering = THREE.MathUtils.lerp(v.steering, state.steering, blend);
    }
    this.apply(v);
    physics.setTruck(v.position, v.rotation);
  }

  private apply(v: VehicleState) {
    this.target.set(v.position.x, v.position.y, v.position.z);
    this.root.parent?.updateWorldMatrix(true, false);
    if (this.root.parent) this.root.parent.worldToLocal(this.target);
    this.root.position.copy(this.target);
    this.quaternion.setFromAxisAngle(this.up, v.rotation);
    if (this.root.parent)
      this.quaternion.premultiply(
        this.root.parent.getWorldQuaternion(this.parentQuaternion).invert(),
      );
    this.root.quaternion.copy(this.quaternion);
    for (const wheel of this.wheels) {
      wheel.quaternion.setFromAxisAngle(this.axle, v.wheelAngle);
      if (/Front/i.test(wheel.name))
        wheel.quaternion.premultiply(this.quaternion.setFromAxisAngle(this.up, v.steering));
    }
    this.root.updateMatrixWorld(true);
  }

  get position() {
    return this.displayed?.position;
  }
}
