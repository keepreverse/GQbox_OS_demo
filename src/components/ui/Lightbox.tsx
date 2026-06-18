/**
 * Lightbox component for viewing media files.
 *
 * Features:
 * - Counter (1 / 5)
 * - Delete
 * - Download
 * - Keyboard navigation (Left / Right arrows)
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import Modal from './Modal';
import { useLanguage } from '@context/LanguageContext';
import { MediaFile } from '@app-types';
import {
  ChevronLeft,
  ChevronRight,
  Trash2,
  Download,
} from 'lucide-react';
import { getMediaUrl } from '@utils/media';

interface LightboxProps {
  open: boolean;
  files: MediaFile[];
  currentIndex: number;
  onClose: () => void;
  onChangeIndex: (index: number) => void;
  onDelete?: (fileId: string) => void;
}

export default function Lightbox({
  open,
  files,
  currentIndex,
  onClose,
  onChangeIndex,
  onDelete,
}: LightboxProps) {
  const { t } = useLanguage();

  // Keep last valid index so we don't flash back to 0 while closing
  const lastValidIndexRef = useRef(currentIndex);
  if (currentIndex >= 0 && currentIndex < files.length) {
    lastValidIndexRef.current = currentIndex;
  }
  const displayIndex =
    currentIndex >= 0 && currentIndex < files.length
      ? currentIndex
      : lastValidIndexRef.current;
  const file = files[displayIndex];

  const total = files.length;
  const goPrev = useCallback(() => {
    onChangeIndex(displayIndex === 0 ? total - 1 : displayIndex - 1);
  }, [displayIndex, onChangeIndex, total]);

  const goNext = useCallback(() => {
    onChangeIndex(displayIndex === total - 1 ? 0 : displayIndex + 1);
  }, [displayIndex, onChangeIndex, total]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, goPrev, goNext, onClose]);

  // Snappy fade-in on navigation: old image disappears instantly,
  // new one fades in over 120ms (no visible background flash)
  const [imgIndex, setImgIndex] = useState(displayIndex);
  const [imgVisible, setImgVisible] = useState(true);
  const isFirstRender = useRef(true);

  // Clamp imgIndex when files array shrinks (e.g., after deletion)
  const safeImgIndex =
    imgIndex >= 0 && imgIndex < files.length ? imgIndex : displayIndex;
  const imgFile = files[safeImgIndex] ?? file;

  // Sync imgIndex with displayIndex immediately (no delay)
  useEffect(() => {
    if (displayIndex !== imgIndex) {
      setImgIndex(displayIndex);
    }
  }, [displayIndex]);

  // Trigger fade-in after imgIndex changes (skip on first render)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setImgVisible(false);
    const raf = requestAnimationFrame(() => setImgVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [imgIndex]);

  if (!file) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="centered"
      width="xl"
      height="auto"
      closeOnBackdropClick
      closeOnEsc
      showCloseButton
      contentClassName="p-0 overflow-hidden"
      className="bg-black/80 backdrop-blur-md"
    >
      <div className="relative flex flex-col items-center justify-center min-h-[50vh] max-h-[85vh]">
        {/* Image */}
        <img
          src={getMediaUrl(imgFile.url)}
          alt={imgFile.originalName}
          className="max-w-full max-h-[70vh] object-contain rounded-md transition-opacity duration-150 ease-out"
          style={{ opacity: imgVisible ? 1 : 0 }}
          loading="eager"
        />

        {/* Top bar: counter + actions (no fade, always visible) */}
        <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
          <span className="px-2.5 py-1 rounded-md bg-black/60 text-white text-xs font-medium pointer-events-auto">
            {displayIndex + 1} / {total}
          </span>
          <div className="flex items-center gap-2 pointer-events-auto">
            <a
              href={getMediaUrl(imgFile.url)}
              download={imgFile.originalName}
              className="p-2 rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 cursor-pointer"
              title={t('media.download')}
            >
              <Download className="w-4 h-4" />
            </a>
            {onDelete && (
              <button
                onClick={() => onDelete(imgFile.id)}
                className="p-2 rounded-full bg-black/60 text-white transition-colors hover:bg-danger/80 cursor-pointer"
                title={t('media.delete')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Navigation arrows */}
        {total > 1 && (
          <>
            <button
              onClick={goPrev}
              className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 text-white transition-all duration-150 ease-out hover:bg-black/80 cursor-pointer"
              aria-label={t('media.prev')}
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <button
              onClick={goNext}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 text-white transition-all duration-150 ease-out hover:bg-black/80 cursor-pointer"
              aria-label={t('media.next')}
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </>
        )}

      </div>
    </Modal>
  );
}


