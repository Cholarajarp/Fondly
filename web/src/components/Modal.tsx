import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog on the native <dialog> element: showModal() makes the page behind it inert, Esc
 * closes it, and Tab is kept inside. Focus moves to the dialog on open and back to the opener on close.
 */
export function Modal({
  labelledBy,
  onClose,
  className,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dlg.open) dlg.showModal();
    // Focus the first control (the close button) so screen readers start at the top of the dialog.
    (dlg.querySelector<HTMLElement>("[data-autofocus]") ?? dlg).focus();
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...dlg.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dlg)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("keydown", onKey);
    return () => {
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("keydown", onKey);
      if (dlg.open) dlg.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal ${className ?? ""}`}
      aria-labelledby={labelledBy}
      aria-modal="true"
      tabIndex={-1}
      // A click on the backdrop (the dialog element itself, outside the panel) closes it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">{children}</div>
    </dialog>
  );
}

/** Puts the page in a print mode so only one print sheet (kit handout or poster) is printed. */
export function printSheet(mode: "kit" | "poster") {
  const root = document.documentElement;
  root.dataset.print = mode;
  const done = () => {
    delete root.dataset.print;
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}
