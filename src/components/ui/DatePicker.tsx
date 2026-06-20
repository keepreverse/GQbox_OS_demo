import { useState, useRef, useEffect, useCallback } from 'react';
import { ru } from 'date-fns/locale/ru';
import {
  format, parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, addMonths, subMonths, subDays, startOfDay,
  isSameMonth, isSameDay, isBefore, isAfter, isToday
} from 'date-fns';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

interface DatePickerProps {
  value: string;
  onChange: (date: string) => void;
  min?: string;
  max?: string;
  label?: string;
}

function pos(btn: HTMLButtonElement | null) {
  if (!btn) return {};
  const r = btn.getBoundingClientRect();
  const w = 280;
  const gap = 8;
  let left = r.left;
  if (left + w > window.innerWidth - gap) left = window.innerWidth - w - gap;
  if (left < gap) left = gap;
  return { top: r.bottom + 6, left, width: w };
}

export default function DatePicker({ value, onChange, min, max, label }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState<React.CSSProperties>({});
  const [viewMonth, setViewMonth] = useState(() => (value ? parseISO(value) : new Date()));

  const selected = value ? parseISO(value) : undefined;

  const ABSOLUTE_MIN = startOfDay(subDays(new Date(), 364));
  const ABSOLUTE_MAX = startOfDay(new Date());

  const effectiveMin = min
    ? (startOfDay(parseISO(min)) < ABSOLUTE_MIN ? ABSOLUTE_MIN : startOfDay(parseISO(min)))
    : ABSOLUTE_MIN;
  const effectiveMax = max
    ? (startOfDay(parseISO(max)) > ABSOLUTE_MAX ? ABSOLUTE_MAX : startOfDay(parseISO(max)))
    : ABSOLUTE_MAX;

  const fmt = (iso: string) => (iso ? format(parseISO(iso), 'dd.MM.yyyy') : '');

  const open_ = () => {
    setDropPos(pos(btnRef.current));
    if (value) setViewMonth(parseISO(value));
    setOpen(true);
  };
  const close = () => { setOpen(false); setDropPos({}); };
  const toggle = () => (open ? close() : open_());

  useEffect(() => {
    if (!open) return;
    const onMove = () => setDropPos(pos(btnRef.current));
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(viewMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const locale = ru;
  const monthLabel = format(viewMonth, 'LLLL yyyy', { locale });

  const canGoPrev = startOfMonth(subMonths(viewMonth, 1)) >= startOfMonth(effectiveMin);
  const canGoNext = startOfMonth(addMonths(viewMonth, 1)) <= startOfMonth(effectiveMax);

  const handleDayClick = useCallback((day: Date) => {
    const iso = format(day, 'yyyy-MM-dd');
    onChange(iso);
    close();
  }, [onChange]);

  const isDisabled = useCallback((day: Date) => {
    if (isBefore(day, effectiveMin) || isAfter(day, effectiveMax)) return true;
    return false;
  }, [effectiveMin, effectiveMax]);

  const weekdayNames = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  return (
    <div className="flex items-center gap-1.5">
      {label && (
        <span className="text-[10px] sm:text-xs text-text-tertiary whitespace-nowrap">{label}</span>
      )}
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg bg-bg-secondary border border-border-subtle text-xs text-text-primary outline-none hover:border-border-default transition-colors cursor-pointer min-w-[120px]"
      >
        <Calendar className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="tabular-nums">{fmt(value) || '—'}</span>
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[299]" onClick={close} />
          <div
            className="fixed z-[300] rounded-xl bg-bg-tertiary border border-border-default shadow-2xl overflow-hidden animate-fade-in-fast"
            style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width ?? 280 }}
          >
            <div className="p-2 select-none">
              <div className="flex items-center justify-between h-8 mb-1">
                <button
                  type="button"
                  onClick={() => setViewMonth(subMonths(viewMonth, 1))}
                  disabled={!canGoPrev}
                  className="dp-custom-nav-btn"
                  aria-label="Предыдущий месяц"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs font-medium text-text-primary">{monthLabel}</span>
                <button
                  type="button"
                  onClick={() => setViewMonth(addMonths(viewMonth, 1))}
                  disabled={!canGoNext}
                  className="dp-custom-nav-btn"
                  aria-label="Следующий месяц"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-px mb-1">
                {weekdayNames.map((name: string) => (
                  <div key={name} className="text-[10px] text-text-muted font-medium text-center h-6 flex items-center justify-center uppercase tracking-wider">
                    {name}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-px">
                {days.map((day) => {
                  const isOutside = !isSameMonth(day, viewMonth);
                  const isSel = selected && isSameDay(day, selected);
                  const disabled = isDisabled(day);
                  return (
                    <div key={day.toISOString()} className="flex items-center justify-center">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => handleDayClick(day)}
                        className={[
                          'dp-custom-day-btn',
                          isOutside && 'dp-outside',
                          isSel && 'dp-selected',
                          isToday(day) && 'dp-today',
                          disabled && 'dp-disabled',
                        ].filter(Boolean).join(' ')}
                      >
                        {format(day, 'd')}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
