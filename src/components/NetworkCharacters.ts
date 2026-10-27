import * as THREE from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { applyAppearance } from "../utils/appearance";
import type { AnimationState, PlayerState, CharacterModel } from "../network/protocol";

export const characterAssets: Record<CharacterModel, string> = {
  custom: "/models/character.glb",
  person2: "/models/person2.glb",
  person3: "/models/person3.glb",
  ceo: "/models/ceo-character.glb",
};
export const characterClips: Record<CharacterModel, Partial<Record<AnimationState, string>>> = {
  custom: { Idle: "Idle", Walk: "Walk", Run: "Run" },
  person2: { Walk: "walk", Run: "run" },
  person3: { Walk: "Walking", Run: "Running" },
  ceo: { Walk: "Walking", Run: "Running" },
};

/** Keep model normalization separate from animated transforms and network placement. */
export function normalizeCharacter(model: THREE.Object3D): THREE.Group {
  const root = new THREE.Group();
  const placement = new THREE.Group();
  root.add(placement);
  placement.add(model);
  const bounds = new THREE.Box3().setFromObject(model);
  const height = bounds.max.y - bounds.min.y;
  if (height > 0) {
    const scale = 1.6 / height;
    placement.scale.setScalar(scale);
    placement.position.set(
      (-(bounds.min.x + bounds.max.x) * scale) / 2,
      -bounds.min.y * scale,
      (-(bounds.min.z + bounds.max.z) * scale) / 2,
    );
  }
  return root;
}

/** Lock horizontal hip/root translation so locomotion cannot add network displacement. */
export function movementClip(
  clip: THREE.AnimationClip,
  model: THREE.Object3D,
): THREE.AnimationClip {
  const result = clip.clone();
  for (const track of result.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const node = model.getObjectByName(track.name.slice(0, -9));
    if (!node || (!/hips|root/i.test(node.name) && node !== model)) continue;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = node.position.x;
      track.values[i + 2] = node.position.z;
    }
  }
  return result;
}

type Instance = {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AnimationState, THREE.AnimationAction>>;
  state?: AnimationState;
};

/** Clones share geometry/textures but own skeletons and materials for independent appearances. */
export class NetworkCharacters {
  readonly objects = new Map<string, THREE.Object3D>();
  private readonly instances = new Map<string, Instance>();
  private readonly target = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scene: THREE.Scene;
  private readonly templates = new Map<
    CharacterModel,
    { root: THREE.Object3D; clips: THREE.AnimationClip[] }
  >();
  addTemplate(model: CharacterModel, root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.templates.set(model, { root, clips });
  }
  constructor(scene: THREE.Scene, template: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.scene = scene;
    this.addTemplate("custom", template, clips);
  }

  update(players: ReadonlyMap<string, PlayerState>, delta: number, localPlayerId?: string | null) {
    for (const id of this.objects.keys()) if (!players.has(id)) this.remove(id);
    for (const [id, player] of players) {
      let instance = this.instances.get(id);
      if (!instance) {
        const modelId = player.model ?? "custom";
        const template = this.templates.get(modelId);
        if (!template) continue;
        const model = clone(template.root);
        const root = normalizeCharacter(model);
        // Clone each source material once per character, preserving intra-model sharing.
        const materials = new Map<THREE.Material, THREE.Material>();
        const ownMaterial = (material: THREE.Material) => {
          if (!materials.has(material)) materials.set(material, material.clone());
          return materials.get(material)!;
        };
        root.traverse((object) => {
          if (object instanceof THREE.Mesh)
            object.material = Array.isArray(object.material)
              ? object.material.map(ownMaterial)
              : ownMaterial(object.material);
        });
        if (player.appearance) applyAppearance(root, player.appearance);
        root.position.set(player.position.x, player.position.y, player.position.z);
        root.rotation.y = player.rotation;
        const mixer = new THREE.AnimationMixer(model);
        const actions: Instance["actions"] = {};
        for (const state of ["Idle", "Walk", "Run"] as const) {
          const clip = template.clips.find((clip) => clip.name === characterClips[modelId][state]);
          if (clip) actions[state] = mixer.clipAction(movementClip(clip, model));
        }
        instance = { root, mixer, actions };
        this.instances.set(id, instance);
        this.objects.set(id, root);
        this.scene.add(root);
      }
      const { root, mixer, actions } = instance;
      this.target.set(player.position.x, player.position.y, player.position.z);
      // Only remote snapshots are interpolated; local physics must render without network lag.
      if (id === localPlayerId || root.position.distanceToSquared(this.target) > 25)
        root.position.copy(this.target);
      else root.position.lerp(this.target, 1 - Math.exp(-20 * delta));
      this.rotation.setFromAxisAngle(this.up, player.rotation);
      if (id === localPlayerId) root.quaternion.copy(this.rotation);
      else root.quaternion.slerp(this.rotation, 1 - Math.exp(-20 * delta));
      if (instance.state !== player.animation) {
        if (!actions[player.animation]) mixer.stopAllAction();
        else {
          if (instance.state) actions[instance.state]?.fadeOut(0.2);
          actions[player.animation]!.reset().fadeIn(0.2).play();
        }
        instance.state = player.animation;
      }
      mixer.update(delta);
    }
  }

  private remove(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.mixer.stopAllAction();
    instance.mixer.uncacheRoot(instance.mixer.getRoot());
    const materials = new Set<THREE.Material>();
    instance.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
        if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      }
    });
    materials.forEach((material) => material.dispose());
    // Geometry and textures belong to the template and survive until the scene is disposed.
    this.scene.remove(instance.root);
    this.instances.delete(id);
    this.objects.delete(id);
  }

  dispose() {
    for (const id of this.objects.keys()) this.remove(id);
  }
}
