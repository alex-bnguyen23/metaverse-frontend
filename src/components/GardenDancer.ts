import * as THREE from "three";

/** Alternates complete dance clips without restarting actions on every rendered frame. */
export class GardenDancer {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: THREE.AnimationAction[];
  private readonly root: THREE.Object3D;
  private index = 0;
  private readonly onFinished = () => {
    this.actions[this.index].stop();
    this.index = (this.index + 1) % this.actions.length;
    this.actions[this.index].reset().play();
  };

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = clips.map((clip) => {
      const action = this.mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      return action;
    });
    this.mixer.addEventListener("finished", this.onFinished);
    this.actions[0].play();
  }

  update(delta: number) {
    this.mixer.update(delta);
  }

  dispose() {
    this.mixer.removeEventListener("finished", this.onFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    // Geometry, skeletons, materials and textures belong to World scene cleanup.
  }
}
