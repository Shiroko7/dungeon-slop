import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ConfirmRequest {
  title: string;
  /** One sentence of context. Keep the consequences in `consequences`. */
  body?: string;
  /**
   * What will actually be destroyed, counted. A confirmation that only says
   * "are you sure?" teaches people to click through it; one that says
   * "3 dungeons, 14 notes" is worth reading.
   */
  consequences?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

interface Pending extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

/**
 * A promise-shaped confirmation.
 *
 * `const { ask, dialog } = useConfirm()` — call `await ask({...})` at the point
 * of the destructive action and render `{dialog}` somewhere in the component.
 * Keeping it local rather than global means each view states its own
 * consequences, which is the part that makes a confirmation useful.
 */
export function useConfirm(): {
  ask: (request: ConfirmRequest) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending((previous) => {
          // A second prompt while one is open abandons the first rather than
          // leaving its caller awaiting a promise that will never settle.
          previous?.resolve(false);
          return { ...request, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    setPending((previous) => {
      previous?.resolve(confirmed);
      return null;
    });
  }, []);

  useEffect(() => {
    if (pending === null) return;
    // Focus the safe option: this is a destructive prompt, so a stray Enter
    // should back out, not go through.
    cancelRef.current?.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  const dialog =
    pending === null
      ? null
      : createPortal(
          <div
            className="confirm-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) settle(false);
            }}
          >
            <div className="confirm-card" role="alertdialog" aria-modal="true" aria-label={pending.title}>
              <h2 className="confirm-title">{pending.title}</h2>

              {pending.body !== undefined && <p className="confirm-body">{pending.body}</p>}

              {pending.consequences !== undefined && pending.consequences.length > 0 && (
                <ul className="confirm-consequences">
                  {pending.consequences.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}

              <p className="confirm-note">This cannot be undone.</p>

              <div className="confirm-actions">
                <button ref={cancelRef} className="confirm-cancel" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? "Cancel"}
                </button>
                <button className="confirm-danger" onClick={() => settle(true)}>
                  {pending.confirmLabel ?? "Delete"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        );

  return { ask, dialog };
}

/** "3 dungeons" / "1 dungeon" / null when there is nothing to mention. */
export function countLine(n: number, singular: string, plural = `${singular}s`): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? singular : plural}`;
}
