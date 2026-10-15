"use client";

import type { CreativeDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ImagePlus, Loader2, MoreHorizontal, Search, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { CreativeThumb, fileSize, formatLabel } from "@/components/creatives/creative-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, apiUpload } from "@/lib/api";
import { longDate } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useCreatives } from "@/lib/queries";
import { cn } from "@/lib/utils";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm";

export default function CreativesPage() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const creatives = useCreatives(workspace.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<"ALL" | "IMAGE" | "VIDEO">("ALL");
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<CreativeDTO | null>(null);
  const canEdit = can("campaigns:edit");

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(list.length);
    try {
      // Upload in batches of 10 (the server limit per request).
      for (let i = 0; i < list.length; i += 10) {
        const form = new FormData();
        list.slice(i, i + 10).forEach((f) => form.append("files", f));
        await apiUpload<CreativeDTO[]>(`/workspaces/${workspace.id}/creatives`, form);
      }
      toast.success(`${list.length} ${list.length === 1 ? "file" : "files"} uploaded`);
      await queryClient.invalidateQueries({ queryKey: qk2.creatives(workspace.id) });
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(0);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api(`/workspaces/${workspace.id}/creatives/${deleting.id}`, { method: "DELETE" });
      toast.success("Creative deleted");
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: qk2.creatives(workspace.id) });
    } catch (err) {
      toastError(err);
    }
  }

  const items = (creatives.data ?? []).filter(
    (c) => (tab === "ALL" || c.type === tab) && (!search || c.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div
      className="space-y-6"
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (canEdit) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <PageHeader
        title="Creatives"
        description="Images and videos for your ads. Use them in the campaign builder on any platform."
        actions={
          canEdit && (
            <Button onClick={() => inputRef.current?.click()} disabled={uploading > 0}>
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
              {uploading ? `Uploading ${uploading}…` : "Upload"}
            </Button>
          )
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="ALL">All</TabsTrigger>
            <TabsTrigger value="IMAGE">Images</TabsTrigger>
            <TabsTrigger value="VIDEO">Videos</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by file name…" className="h-8 pl-8" />
        </div>
      </div>

      {creatives.isError ? (
        <Card><ErrorState message={creatives.error.message} onRetry={() => creatives.refetch()} /></Card>
      ) : !creatives.data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5] rounded-xl" />)}
        </div>
      ) : creatives.data.length === 0 ? (
        <Card
          className={cn("border-2 border-dashed transition-colors", dragging && "border-primary bg-primary/5")}
        >
          <EmptyState
            icon={ImagePlus}
            title="Your creative library is empty"
            description="Drag images or videos here, or upload them. PNG, JPG, WebP, GIF, MP4, MOV and WebM are supported."
            action={canEdit && <Button onClick={() => inputRef.current?.click()}><Upload /> Upload files</Button>}
          />
        </Card>
      ) : items.length === 0 ? (
        <Card><EmptyState icon={Search} title="No matches" description="Try a different search or filter." /></Card>
      ) : (
        <div className={cn("grid grid-cols-2 gap-4 rounded-xl transition-colors sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", dragging && "bg-primary/5 ring-2 ring-primary ring-offset-4 ring-offset-background")}>
          {items.map((c, i) => (
            <Card key={c.id} className="group gap-0 overflow-hidden py-0 animate-fade-up" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
              <CreativeThumb creative={c} className="aspect-square border-b" />
              <div className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={c.name}>{c.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {formatLabel(c) && <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">{formatLabel(c)}</Badge>}
                    <span className="text-[11px] text-muted-foreground">{fileSize(c.sizeBytes)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Added {longDate(c.createdAt.slice(0, 10))}</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="-mr-1 opacity-60 group-hover:opacity-100" aria-label="Creative actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        void navigator.clipboard.writeText(new URL(c.url, window.location.origin).toString());
                        toast.success("Link copied");
                      }}
                    >
                      <Copy /> Copy link
                    </DropdownMenuItem>
                    {canEdit && (
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from your library. Ads already running on ad platforms keep their copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={remove}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
