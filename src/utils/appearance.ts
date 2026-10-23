import * as THREE from "three";
// Numeric values correspond to dressing-room choice indexes.
export type Appearance = { shirt: 0 | 1 | 2; pants: 0 | 1; hairstyle: 0 | 1; glasses: 0 | 1 };
export const STORAGE_KEY = "osaka-character-appearance";
export const defaultAppearance: Appearance = { shirt: 0, pants: 0, hairstyle: 0, glasses: 0 };
/** Restore saved choices, validating each field against the supported option indexes. */
export function loadAppearance(): Appearance {
  try {
    // Missing data becomes null; invalid JSON or unavailable storage uses the catch fallback.
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    // Validate fields separately so one invalid choice does not discard the other valid choices.
    return {
      shirt: saved?.shirt === 1 || saved?.shirt === 2 ? saved.shirt : 0,
      pants: saved?.pants === 1 ? 1 : 0,
      hairstyle: saved?.hairstyle === 1 ? 1 : 0,
      glasses: saved?.glasses === 1 ? 1 : 0,
    };
  } catch {
    return { ...defaultAppearance };
  }
}
/** Update accessories and colors using object/material names authored in Blender. */
export function applyAppearance(root: THREE.Object3D, appearance: Appearance) {
  root.traverse((object) => {
    // Accessories may be groups, so toggle them before filtering for meshes.
    if (/glasses/i.test(object.name)) object.visible = appearance.glasses === 1;
    if (/ponytail/i.test(object.name)) object.visible = appearance.hairstyle === 1;
    if (!(object instanceof THREE.Mesh)) return;
    // A mesh can have one material or several; handle both using the same loop.
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      // Only standard materials support the color handling expected by this model.
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.name === "Switchable shirt")
        material.color.set(["#d73535", "#2869cf", "#299447"][appearance.shirt]);
      if (material.name === "Switchable pants")
        material.color.set(["#171c24", "#244c96"][appearance.pants]);
    }
  });
}
