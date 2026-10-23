import { useCallback, useEffect, useRef, type PointerEvent } from "react";

export type JoystickInput = { forward: number; right: number; running: boolean };

export default function TouchJoystick({ onChange }: { onChange: (input: JoystickInput) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const pointer = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<JoystickInput>({ forward: 0, right: 0, running: false });

  const stopMovement = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    input.current = { forward: 0, right: 0, running: false };
    onChange(input.current);
  }, [onChange]);

  const reset = useCallback(() => {
    pointer.current = null;
    if (knob.current) knob.current.style.transform = "translate(0px, 0px)";
    stopMovement();
  }, [stopMovement]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px), (any-pointer: coarse)");
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    document.addEventListener("focusin", reset);
    media.addEventListener("change", reset);
    return () => {
      reset();
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      document.removeEventListener("focusin", reset);
      media.removeEventListener("change", reset);
    };
  }, [reset]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== pointer.current || !base.current) return;
    const bounds = base.current.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(x, y);
    const radius = bounds.width / 2 - 28;
    const scale = distance > radius ? radius / distance : 1;
    if (knob.current) knob.current.style.transform = `translate(${x * scale}px, ${y * scale}px)`;
    // A dead zone prevents small resting-finger movements from moving the character.
    if (distance < 12) {
      stopMovement();
      return;
    }
    input.current = { forward: -y / distance, right: x / distance, running: input.current.running };
    onChange(input.current);
    if (!input.current.running && timer.current === undefined) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        input.current = { ...input.current, running: true };
        onChange(input.current);
      }, 1000);
    }
  };

  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === pointer.current) reset();
  };

  return (
    <div
      ref={base}
      className="touch-joystick"
      role="group"
      aria-label="Movement joystick: drag to walk, hold one second to run"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <span ref={knob} className="touch-joystick-knob" aria-hidden="true" />
    </div>
  );
}
