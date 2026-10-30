"use client";

import { toISODate } from "@ashniva/shared";
import { format, parseISO } from "date-fns";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { DateRange as DayRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESET_LABELS, useDateRange, useDateRangeStore, type RangePreset } from "@/lib/date-range";
import { cn } from "@/lib/utils";

const PRESETS = Object.entries(PRESET_LABELS) as [Exclude<RangePreset, "custom">, string][];

function describe(from: string, to: string) {
  const f = parseISO(from);
  const t = parseISO(to);
  if (from === to) return format(f, "d MMM yyyy");
  const sameYear = f.getFullYear() === t.getFullYear();
  return `${format(f, sameYear ? "d MMM" : "d MMM yyyy")} – ${format(t, "d MMM yyyy")}`;
}

export function DateRangePicker({ className }: { className?: string }) {
  const range = useDateRange();
  const { setPreset, setCustom } = useDateRangeStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DayRange | undefined>();
  /** True after the first click of a new selection, until the end day is picked. */
  const [picking, setPicking] = useState(false);

  // Each pick starts fresh: the first click selects that one day, the second sets the other end.
  // (react-day-picker's default would stretch or shrink the range that was already there.)
  const onPick = (_range: DayRange | undefined, day: Date) => {
    if (!picking || !draft?.from) {
      setDraft({ from: day, to: day });
      setPicking(true);
      return;
    }
    const start = draft.from;
    setDraft(day < start ? { from: day, to: start } : { from: start, to: day });
    setPicking(false);
  };
  const from = draft?.from;
  const to = draft?.to ?? draft?.from;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setDraft({ from: parseISO(range.from), to: parseISO(range.to) });
          setPicking(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("h-8 gap-2 bg-card font-normal", className)}>
          <CalendarDays className="text-muted-foreground" />
          <span className="hidden font-medium sm:inline">{range.label}</span>
          <span className="hidden text-muted-foreground md:inline">· {describe(range.from, range.to)}</span>
          <span className="sm:hidden">{describe(range.from, range.to)}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row flex-wrap gap-1 border-b p-2 sm:w-40 sm:flex-col sm:border-r sm:border-b-0">
            {PRESETS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setPreset(key);
                  setOpen(false);
                }}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                  range.preset === key && "bg-accent font-medium text-accent-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="p-2">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draft}
              onSelect={onPick}
              defaultMonth={draft?.from}
              disabled={{ after: new Date() }}
              className="hidden sm:block"
            />
            <Calendar
              mode="range"
              numberOfMonths={1}
              selected={draft}
              onSelect={onPick}
              defaultMonth={draft?.from}
              disabled={{ after: new Date() }}
              className="sm:hidden"
            />
            <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {from && to ? (
                  <>
                    <span className="font-medium text-foreground">{describe(toISODate(toUTC(from)), toISODate(toUTC(to)))}</span>
                    {picking && " · pick an end date, or apply this day"}
                  </>
                ) : (
                  "Select a start and end date"
                )}
              </span>
              <Button
                size="sm"
                disabled={!from || !to}
                onClick={() => {
                  if (!from || !to) return;
                  setCustom({ from: toISODate(toUTC(from)), to: toISODate(toUTC(to)) });
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Calendar dates are local midnight; convert to the same calendar day in UTC. */
const toUTC = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
