import type { Gesture } from "../../shared/control-contracts";

export type HardwareKey = Extract<
  Gesture,
  { type: "back" | "home" | "recents" | "power" }
>["type"];

type Props = {
  onPress: (key: HardwareKey) => void;
  disabled?: boolean;
};

const BUTTONS: { key: HardwareKey; label: string }[] = [
  { key: "back", label: "Back" },
  { key: "home", label: "Home" },
  { key: "recents", label: "Recents" },
  { key: "power", label: "Power" },
];

export function ControlBar({ onPress, disabled = false }: Props) {
  return (
    <footer>
      {BUTTONS.map((b) => (
        <button key={b.key} disabled={disabled} onClick={() => onPress(b.key)}>
          {b.label}
        </button>
      ))}
    </footer>
  );
}
