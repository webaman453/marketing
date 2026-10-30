"use client";

import { planHasFeature } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { SettingsCard } from "@/components/settings/settings-card";
import { UpgradeCard } from "@/components/settings/upgrade-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NoAccess } from "@/components/settings/no-access";
import { api, apiUpload } from "@/lib/api";
import { useCatalog } from "@/lib/catalog";
import { toastError } from "@/lib/forms";
import { qk } from "@/lib/queries";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";

export default function BrandingPage() {
  const { org, workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  useCatalog();
  const b = org.branding;
  // Empty means "use the organization name", so a later rename still reaches reports.
  const [name, setName] = useState(b.brandName ?? "");
  const [color, setColor] = useState(b.brandColor ?? "#3b5bdb");
  const [footer, setFooter] = useState(b.reportFooter ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = name !== (b.brandName ?? "") || color !== (b.brandColor ?? "#3b5bdb") || footer !== (b.reportFooter ?? "");
  useUnsavedChanges(dirty && !saving && can("org:update") && planHasFeature(org.plan, "white_label"));

  if (!can("org:update")) return <NoAccess what="branding" />;
  if (!planHasFeature(org.plan, "white_label")) {
    return (
      <UpgradeCard
        feature="white_label"
        workspaceId={workspace.id}
        description="Put your agency's logo, colours and footer on PDF reports, scheduled emails and shared report links."
      />
    );
  }

  const validColor = /^#[0-9a-fA-F]{6}$/.test(color);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.me });

  async function save() {
    setSaving(true);
    try {
      await api(`/orgs/${org.id}/branding`, { method: "PATCH", body: { brandName: name || null, brandColor: color, reportFooter: footer || null } });
      await refresh();
      toast.success("Branding saved", { description: "Applied to new reports, emails and shared links." });
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File) {
    if (!["image/png", "image/jpeg"].includes(file.type)) return toast.error("Logos must be PNG or JPG.");
    if (file.size > 2 * 1024 * 1024) return toast.error("That logo is over 2 MB.", { description: "Export a smaller PNG or JPG and try again." });
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiUpload(`/orgs/${org.id}/branding/logo`, form);
      await refresh();
      toast.success("Logo updated");
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  }

  async function removeLogo() {
    setRemoving(true);
    try {
      await api(`/orgs/${org.id}/branding/logo`, { method: "DELETE" });
      await refresh();
      toast.success("Logo removed");
    } catch (err) {
      toastError(err);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsCard
        title="White-label branding"
        description="Your clients see this on PDF reports, scheduled report emails and shared report links."
        footer={
          <Button size="sm" onClick={save} disabled={saving || !validColor}>
            {saving && <Loader2 className="animate-spin" />} Save branding
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <span className="text-[13px] font-medium">Logo</span>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-40 items-center justify-center rounded-lg border bg-muted/30 p-2">
                {b.brandLogoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.brandLogoUrl} alt="Logo" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">No logo</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} {b.brandLogoUrl ? "Replace" : "Upload logo"}
                </Button>
                {b.brandLogoUrl && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={removeLogo} disabled={removing}>
                    {removing ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">PNG or JPG, under 2 MB. A wide logo on a transparent background works best.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="brand-name" label="Display name" hint="Shown when there's no logo, and as the email sender name. Leave empty to use your organization name.">
              <Input id="brand-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={org.name} />
            </FormField>
            <FormField id="brand-color" label="Brand colour" error={validColor ? undefined : { message: "Use a hex colour like #3b5bdb" }}>
              <div className="flex gap-2">
                <input type="color" value={validColor ? color : "#3b5bdb"} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1" aria-label="Pick colour" />
                <Input id="brand-color" value={color} onChange={(e) => setColor(e.target.value)} className="font-mono" maxLength={7} />
              </div>
            </FormField>
          </div>
          <FormField id="footer" label="Report footer" hint="e.g. your contact details or a confidentiality note.">
            <Input id="footer" value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={200} placeholder={`Prepared by ${org.name}`} />
          </FormField>
        </div>
      </SettingsCard>

      <SettingsCard title="Preview" description="How the top of a PDF report will look.">
        <div className="overflow-hidden rounded-lg border bg-white p-5 text-[#1c2333]">
          <div className="flex items-start justify-between">
            {b.brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.brandLogoUrl} alt="" className="max-h-8 max-w-[140px] object-contain" />
            ) : (
              <span className="text-base font-bold" style={{ color: validColor ? color : "#3b5bdb" }}>{name || org.name}</span>
            )}
            <span className="text-right text-xs text-gray-500">{workspace.name}<br />Last 30 days</span>
          </div>
          <div className="mt-3 h-0.5" style={{ background: validColor ? color : "#3b5bdb" }} />
          <p className="mt-4 text-lg font-bold">Monthly performance summary</p>
          <p className="mt-6 border-t pt-2 text-[10px] text-gray-500">{footer || `Prepared by ${name || org.name}`}</p>
        </div>
      </SettingsCard>
    </div>
  );
}
