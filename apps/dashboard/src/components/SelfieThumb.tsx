import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A selfie thumbnail that opens the full-size image in a lightbox on click, so
 * reviewers can verify identity. The signed URL already points at the full-res
 * photo; this just presents it larger. Closes on backdrop click, the ✕, or Esc.
 */
export function SelfieThumb({
  src,
  alt,
  className,
  frameClassName = 'rounded-full',
}: {
  src: string;
  alt: string;
  className?: string;
  /** Rounding/layout of the clickable frame; match the thumbnail shape. */
  frameClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // Prevent the page behind the lightbox from scrolling.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Click to enlarge and verify"
        className={`block cursor-zoom-in ring-brand-400 transition hover:ring-2 focus:outline-none focus:ring-2 ${frameClassName}`}
      >
        <img src={src} alt={alt} className={className} />
      </button>

      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white hover:bg-white/20"
            >
              ✕
            </button>
            <figure onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={src}
                alt={alt}
                className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              />
              <figcaption className="text-sm text-gray-200">{alt}</figcaption>
            </figure>
          </div>,
          document.body,
        )}
    </>
  );
}
