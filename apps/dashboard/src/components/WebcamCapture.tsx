import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  /** base64 jpeg (no data: prefix), or null when the user proceeds without a camera. */
  onCapture: (selfieB64: string | null) => void;
  onCancel: () => void;
}

/**
 * Front-camera selfie in the browser. By product decision a punch must NEVER
 * be blocked by the camera: permission denied, no device, or an insecure
 * context (plain-HTTP LAN) offers a "continue without selfie" path — the punch
 * gets flagged for HR instead. Mirrors the mobile SelfieCamera behaviour.
 */
export function WebcamCapture({ title, onCapture, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setFailed(true);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
        setReady(true);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      stop();
    };
  }, [stop]);

  const capture = () => {
    if (busy) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setFailed(true);
      return;
    }
    setBusy(true);
    const scale = Math.min(1, 640 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setFailed(true);
      setBusy(false);
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const b64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? null;
    stop();
    onCapture(b64);
  };

  const skip = () => {
    stop();
    onCapture(null);
  };
  const cancel = () => {
    stop();
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-6">
      <p className="mb-4 max-w-sm text-center text-base font-semibold text-white">{title}</p>

      {failed ? (
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
          <p className="text-sm text-muted">
            The camera is unavailable. You can continue — the punch will be marked “no selfie” and
            HR will review it.
          </p>
          <button onClick={skip} className="btn-primary mt-4 w-full">
            Continue without selfie
          </button>
          <button onClick={cancel} className="btn mt-2 w-full">
            Cancel
          </button>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className="max-h-[60vh] w-full max-w-sm -scale-x-100 rounded-2xl bg-black object-cover"
          />
          <div className="mt-5 flex w-full max-w-sm flex-col gap-2">
            <button
              onClick={capture}
              disabled={!ready || busy}
              className="btn-primary w-full disabled:opacity-50"
            >
              {busy ? 'Capturing…' : 'Take selfie'}
            </button>
            <button onClick={skip} className="btn w-full">
              Continue without selfie
            </button>
            <button onClick={cancel} className="py-1 text-center text-sm text-white/70 hover:text-white">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
