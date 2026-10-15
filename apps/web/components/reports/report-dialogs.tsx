"use client";

import type { ReportDTO } from "@ashniva/shared";
import { Check, Copy, Link2, Loader2, Mail, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { toastError } from "@/lib/forms";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`;

export function ScheduleDialog({
  report,
  workspaceId,
  timezone,
  open,
  onOpenChange,
  onSaved,
}: {
  report: ReportDTO;
  workspaceId: string;
  timezone: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (r: ReportDTO) => void;
}) {
  const s = report.schedule;
  const [frequency, setFrequency] = useState<string>(s.frequency ?? "WEEKLY");
  const [hour, setHour] = useState(s.hour);
  const [dayOfWeek, setDayOfWeek] = useState(s.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(s.dayOfMonth);
  const [recipients, setRecipients] = useState<string[]>(s.recipients);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"save" | "off" | "send" | null>(null);

  function addEmail() {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return toast.error("Enter a valid email address");
    if (!recipients.includes(e)) setRecipients([...recipients, e]);
    setEmail("");
  }

  async function save(off = false) {
    setBusy(off ? "off" : "save");
    try {
      const updated = await api<ReportDTO>(`/workspaces/${workspaceId}/reports/${report.id}/schedule`, {
        method: "PUT",
        body: off ? { frequency: null, recipients } : { frequency, hour, dayOfWeek, dayOfMonth, recipients },
      });
      onSaved(updated);
      toast.success(off ? "Schedule turned off" : "Schedule saved", {
        description: updated.schedule.nextRunAt ? `Next email ${dateTime(updated.schedule.nextRunAt)}` : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    setBusy("send");
    try {
      onSaved(await api<ReportDTO>(`/workspaces/${workspaceId}/reports/${report.id}/send`, { method: "POST" }));
      toast.success(`Report sent to ${recipients.length} ${recipients.length === 1 ? "recipient" : "recipients"}`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Email this report</DialogTitle>
          <DialogDescription>Recipients get a PDF on schedule ({timezone}).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField id="freq" label="Frequency">
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger id="freq" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAILY">Daily</SelectItem>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            {frequency === "WEEKLY" && (
              <FormField id="dow" label="On">
                <Select value={String(dayOfWeek)} onValueChange={(v) => setDayOfWeek(Number(v))}>
                  <SelectTrigger id="dow" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{DAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
            )}
            {frequency === "MONTHLY" && (
              <FormField id="dom" label="Day of month">
                <Select value={String(dayOfMonth)} onValueChange={(v) => setDayOfMonth(Number(v))}>
                  <SelectTrigger id="dom" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
            )}
            <FormField id="hour" label="At">
              <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                <SelectTrigger id="hour" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField id="to" label="Recipients">
            <div className="flex gap-2">
              <Input
                id="to"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
                placeholder="client@company.com"
              />
              <Button type="button" variant="outline" onClick={addEmail}>Add</Button>
            </div>
          </FormField>
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recipients.map((r) => (
                <span key={r} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                  <Mail className="size-3 text-muted-foreground" /> {r}
                  <button type="button" onClick={() => setRecipients(recipients.filter((x) => x !== r))} aria-label={`Remove ${r}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {s.lastRunAt && <p className="text-xs text-muted-foreground">Last sent {dateTime(s.lastRunAt)}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            {s.frequency && (
              <Button variant="ghost" className="text-destructive" disabled={!!busy} onClick={() => save(true)}>
                {busy === "off" && <Loader2 className="animate-spin" />} Turn off
              </Button>
            )}
            {s.recipients.length > 0 && (
              <Button variant="ghost" disabled={!!busy} onClick={sendNow}>
                {busy === "send" && <Loader2 className="animate-spin" />} Send now
              </Button>
            )}
          </div>
          <Button disabled={!!busy || recipients.length === 0} onClick={() => save()}>
            {busy === "save" && <Loader2 className="animate-spin" />} Save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShareDialog({
  report,
  workspaceId,
  open,
  onOpenChange,
  onSaved,
}: {
  report: ReportDTO;
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (r: ReportDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = report.shareToken && typeof window !== "undefined" ? `${window.location.origin}/r/${report.shareToken}` : null;

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      onSaved(await api<ReportDTO>(`/workspaces/${workspaceId}/reports/${report.id}/share`, { method: on ? "POST" : "DELETE" }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a live link</DialogTitle>
          <DialogDescription>
            Anyone with the link can view this report (with your branding) without signing in. Numbers stay up to date.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input value={link} readOnly className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button variant="ghost" className="px-0 text-destructive hover:bg-transparent" disabled={busy} onClick={() => toggle(false)}>
              Disable link
            </Button>
          </div>
        ) : (
          <DialogFooter>
            <Button onClick={() => toggle(true)} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Create link
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
