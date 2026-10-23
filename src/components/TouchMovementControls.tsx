import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import "./TouchMovementControls.css";

export type TouchDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ShiftLeft";

const directions = [
  { code: "ArrowUp", label: "Move forward", symbol: "↑", row: 1, column: 2 },
  { code: "ArrowLeft", label: "Move left", symbol: "←", row: 2, column: 1 },
  { code: "ArrowDown", label: "Move backward", symbol: "↓", row: 2, column: 2 },
  { code: "ArrowRight", label: "Move right", symbol: "→", row: 2, column: 3 },
] as const;

export default function TouchMovementControls({
  onChange,
}: {
  onChange: (directions: ReadonlySet<TouchDirection>) => void;
}) {
  const pointers = useRef(new Map<number, TouchDirection>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const runningPointers = useRef(new Set<number>());
  const publish = useCallback(() => {
    const input = new Set(pointers.current.values());
    if (runningPointers.current.size > 0) input.add("ShiftLeft");
    onChange(input);
  }, [onChange]);

  useEffect(() => {
    const heldPointers = pointers.current;
    const heldTimers = timers.current;
    const heldRunningPointers = runningPointers.current;
    const clear = () => {
      heldTimers.forEach(clearTimeout);
      heldTimers.clear();
      heldRunningPointers.clear();
      heldPointers.clear();
      onChange(new Set());
    };
    // Mobile browsers may cancel touches without a pointer-up when focus changes.
    const media = window.matchMedia("(max-width: 1024px), (any-pointer: coarse)");
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    document.addEventListener("focusin", clear);
    media.addEventListener("change", clear);
    return () => {
      clear();
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      document.removeEventListener("focusin", clear);
      media.removeEventListener("change", clear);
    };
  }, [onChange]);

  const release = (event: PointerEvent<HTMLButtonElement>) => {
    clearTimeout(timers.current.get(event.pointerId));
    timers.current.delete(event.pointerId);
    runningPointers.current.delete(event.pointerId);
    pointers.current.delete(event.pointerId);
    publish();
  };

  const press = (event: PointerEvent<HTMLButtonElement>, code: TouchDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Dismiss chat before starting movement and keep this touch off the orbit camera.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, code);
    const pointerId = event.pointerId;
    clearTimeout(timers.current.get(pointerId));
    // Each held arrow earns running independently, including multi-touch diagonals.
    timers.current.set(
      pointerId,
      setTimeout(() => {
        timers.current.delete(pointerId);
        if (!pointers.current.has(pointerId)) return;
        runningPointers.current.add(pointerId);
        publish();
      }, 1000),
    );
    publish();
  };

  return (
    <div className="touch-movement-controls" role="group" aria-label="Touch movement controls">
      {directions.map(({ code, label, symbol, row, column }) => (
        <button
          key={code}
          type="button"
          aria-label={label}
          style={{ gridRow: row, gridColumn: column }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => press(event, code)}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
        >
          <span aria-hidden="true">{symbol}</span>
        </button>
      ))}
    </div>
  );
}
