import { useEffect, useState, type RefObject } from "react";
import type { Sender } from "./use-stream";

// Android KeyEvent meta state bits (AMETA_*).
const AMETA_SHIFT_ON = 0x1;
const AMETA_ALT_ON = 0x2;
const AMETA_CTRL_ON = 0x1000;

// Non-printable Android keycodes for editing/navigation keys the browser
// reports with a multi-character e.key (so the plain text-injection path
// below never sees them).
const NAV_KEYCODES: Record<string, number> = {
  Backspace: 67,
  Delete: 112,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

// Keyed by e.code (physical key) rather than e.key so Ctrl/Cmd shortcuts
// keep working on non-QWERTY layouts.
const SHORTCUT_KEYCODES: Record<string, number> = {
  KeyA: 29, // select all
  KeyC: 31, // copy
  KeyV: 50, // paste
  KeyX: 52, // cut
  KeyZ: 54, // undo
  KeyY: 53, // redo
};

type DeviceKeyboardOptions = {
  keyboardProxyRef: RefObject<HTMLInputElement>;
  send: Sender;
  enabled?: boolean;
  autoFocus?: boolean;
};

/** Routes input only while the hidden keyboard proxy owns browser focus. */
export function useDeviceKeyboard({
  keyboardProxyRef,
  send,
  enabled = true,
  autoFocus = true,
}: DeviceKeyboardOptions): boolean {
  const [keyboardActive, setKeyboardActive] = useState(autoFocus && enabled);

  // Keyboard input is captured on a hidden, always-focusable proxy input
  // rather than document.body: that's what lets the OS/browser IME attach
  // and fire composition events for CJK and other composed text, and it
  // gives an unambiguous signal (focus/blur) for whether keys are currently
  // routed to the device vs. a sidebar text field.
  useEffect(() => {
    if (enabled && autoFocus) keyboardProxyRef.current?.focus({ preventScroll: true });
  }, [keyboardProxyRef, enabled, autoFocus]);

  useEffect(() => {
    const proxy = keyboardProxyRef.current;
    if (!proxy) return;
    setKeyboardActive(enabled && document.activeElement === proxy);
    proxy.value = "";

    const metaStateFor = (e: KeyboardEvent) =>
      (e.shiftKey ? AMETA_SHIFT_ON : 0) |
      (e.ctrlKey ? AMETA_CTRL_ON : 0) |
      (e.altKey ? AMETA_ALT_ON : 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabled || e.isComposing || e.keyCode === 229) return;

      if (e.key === "Escape") {
        e.preventDefault();
        send({ type: "back" });
        return;
      }

      const shortcutKeycode = (e.ctrlKey || e.metaKey) ? SHORTCUT_KEYCODES[e.code] : undefined;
      if (shortcutKeycode !== undefined) {
        e.preventDefault();
        send({ type: "key", keycode: shortcutKeycode, metaState: AMETA_CTRL_ON });
        return;
      }

      const navKeycode = NAV_KEYCODES[e.key];
      if (navKeycode !== undefined) {
        e.preventDefault();
        send({ type: "key", keycode: navKeycode, metaState: metaStateFor(e) });
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        send({ type: "key", keycode: 66, metaState: metaStateFor(e) });
        return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        send({ type: "text", text: e.key });
      }
    };

    const onCompositionEnd = (e: CompositionEvent) => {
      proxy.value = "";
      if (enabled && e.data) send({ type: "text", text: e.data });
    };

    const onFocus = () => setKeyboardActive(enabled);
    const onBlur = () => setKeyboardActive(false);

    proxy.addEventListener("keydown", onKeyDown);
    proxy.addEventListener("compositionend", onCompositionEnd);
    proxy.addEventListener("focus", onFocus);
    proxy.addEventListener("blur", onBlur);
    return () => {
      proxy.removeEventListener("keydown", onKeyDown);
      proxy.removeEventListener("compositionend", onCompositionEnd);
      proxy.removeEventListener("focus", onFocus);
      proxy.removeEventListener("blur", onBlur);
    };
  }, [keyboardProxyRef, send, enabled]);

  return enabled && keyboardActive;
}
