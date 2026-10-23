export type LocalMovement = { x: number; z: number; running: boolean };

/** Convert viewpoint-relative keyboard or joystick axes into a normalized world direction for local physics.
 * This is local intent only; the socket publishes the resulting position, never these axes.
 */
export function adaptMovementInput(
  forward: number,
  right: number,
  running: boolean,
  viewDirection: { x: number; z: number },
): LocalMovement {
  if (forward === 0 && right === 0) return { x: 0, z: 0, running: false };
  const yaw =
    Math.hypot(viewDirection.x, viewDirection.z) < 1e-6
      ? Math.PI
      : Math.atan2(viewDirection.x, viewDirection.z);
  const x = Math.sin(yaw) * forward - Math.cos(yaw) * right;
  const z = Math.cos(yaw) * forward + Math.sin(yaw) * right;
  const length = Math.hypot(x, z);
  return { x: x / length, z: z / length, running };
}
