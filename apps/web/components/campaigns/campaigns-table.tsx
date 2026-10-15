"use client";

import type { CampaignRowDTO, MetricSet } from "@ashniva/shared";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Pause, Pencil, Play, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { StatusDot } from "@/components/metrics";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { humanize, money, multiple, number, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BudgetDialog } from "./budget-dialog";
import { useBulkCampaignStatus, useSetCampaignStatus } from "./use-campaign-actions";

const metric = (
  key: keyof MetricSet,
  header: string,
  render: (v: number | null, c: string) => string,
  className?: string,
): ColumnDef<CampaignRowDTO> => ({
  id: key,
  accessorFn: (r) => r.metrics[key] ?? -1,
  header,
  cell: ({ row }) => render(row.original.metrics[key] as number | null, row.original.currency),
  meta: { align: "right", className },
  sortDescFirst: true,
});

/** Impressions are the least decision-relevant column, so they drop first on narrower screens. */
const IMPR_CLASS = "hidden 2xl:table-cell";

export function CampaignsTable({
  campaigns,
  totals,
  currency,
  workspaceId,
  canEdit,
}: {
  campaigns: CampaignRowDTO[];
  totals: MetricSet;
  currency: string;
  workspaceId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([{ id: "spend", desc: true }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [editing, setEditing] = useState<CampaignRowDTO | null>(null);
  const setStatus = useSetCampaignStatus(workspaceId);
  const bulk = useBulkCampaignStatus(workspaceId);

  const columns = useMemo<ColumnDef<CampaignRowDTO>[]>(
    () => [
      ...(canEdit
        ? [
            {
              id: "select",
              header: ({ table }) => (
                <Checkbox
                  checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")}
                  onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
                  aria-label="Select all"
                />
              ),
              cell: ({ row }) => (
                <Checkbox
                  checked={row.getIsSelected()}
                  onCheckedChange={(v) => row.toggleSelected(!!v)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Select row"
                />
              ),
              enableSorting: false,
              meta: { className: "w-10 pl-4" },
            } satisfies ColumnDef<CampaignRowDTO>,
          ]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: "Campaign",
        cell: ({ row }) => {
          const c = row.original;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <PlatformIcon platform={c.platform} size="md" />
              <div className="min-w-0">
                <div className="truncate font-medium group-hover:text-primary">{c.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {c.adAccount.name}
                  {c.objective && <> · {humanize(c.objective)}</>}
                </div>
              </div>
            </div>
          );
        },
        meta: { className: "min-w-[280px] max-w-[380px]" },
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const c = row.original;
          const toggleable = c.status === "ACTIVE" || c.status === "PAUSED";
          return (
            <div className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
              {canEdit && toggleable && (
                <Switch
                  checked={c.status === "ACTIVE"}
                  onCheckedChange={(on) => setStatus.mutate({ id: c.id, name: c.name, status: on ? "ACTIVE" : "PAUSED" })}
                  aria-label={c.status === "ACTIVE" ? "Pause campaign" : "Activate campaign"}
                  className="scale-90"
                />
              )}
              <StatusDot status={c.status} />
            </div>
          );
        },
      },
      {
        id: "budget",
        accessorFn: (r) => r.dailyBudget ?? -1,
        header: "Daily budget",
        sortDescFirst: true,
        cell: ({ row }) => {
          const c = row.original;
          const label = c.dailyBudget != null ? money(c.dailyBudget, c.currency) : c.lifetimeBudget != null ? `${money(c.lifetimeBudget, c.currency)} total` : "—";
          if (!canEdit) return label;
          return (
            <button
              className="group/budget -mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(c);
              }}
            >
              {label}
              <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/budget:opacity-100" />
            </button>
          );
        },
        meta: { align: "right" },
      },
      metric("spend", "Spend", (v, c) => money(v, c)),
      metric("impressions", "Impr.", (v) => number(v), IMPR_CLASS),
      metric("clicks", "Clicks", (v) => number(v)),
      metric("ctr", "CTR", (v) => percent(v)),
      metric("conversions", "Conv.", (v) => number(v, { decimals: 1 })),
      metric("cpa", "Cost / conv.", (v, c) => money(v, c, { decimals: 0 })),
      metric("roas", "ROAS", (v) => multiple(v)),
    ],
    [canEdit, setStatus],
  );

  const table = useReactTable({
    data: campaigns,
    columns,
    state: { sorting, rowSelection: selection },
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: (r) => r.original.status === "ACTIVE" || r.original.status === "PAUSED",
  });

  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const runBulk = (status: "ACTIVE" | "PAUSED") =>
    bulk.mutate({ ids: selectedIds, status }, { onSuccess: () => setSelection({}) });

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as { align?: string; className?: string } | undefined;
                  const sorted = h.column.getIsSorted();
                  return (
                    <TableHead
                      key={h.id}
                      className={cn("h-10 whitespace-nowrap", meta?.align === "right" && "text-right", meta?.className, h.index === hg.headers.length - 1 && "pr-4")}
                    >
                      {h.column.getCanSort() ? (
                        <button
                          onClick={h.column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                            sorted && "text-foreground",
                            meta?.align === "right" && "flex-row-reverse",
                          )}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="size-3" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3" />
                          ) : (
                            <ArrowUpDown className="size-3 opacity-30" />
                          )}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                onClick={() => router.push(`/w/${workspaceId}/campaigns/${row.original.id}`)}
                className="group cursor-pointer"
              >
                {row.getVisibleCells().map((cell, i, all) => {
                  const meta = cell.column.columnDef.meta as { align?: string; className?: string } | undefined;
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "py-2.5 whitespace-nowrap tabular",
                        meta?.align === "right" && "text-right",
                        meta?.className,
                        cell.column.id === "spend" && "font-medium",
                        i === 0 && !canEdit && "pl-4",
                        i === all.length - 1 && "pr-4",
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {canEdit && <TableCell className="pl-4" />}
              <TableCell className={cn("font-medium", !canEdit && "pl-4")}>
                Total · {campaigns.length} {campaigns.length === 1 ? "campaign" : "campaigns"}
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell className="text-right font-semibold tabular">{money(totals.spend, currency)}</TableCell>
              <TableCell className={cn("text-right tabular", IMPR_CLASS)}>{number(totals.impressions)}</TableCell>
              <TableCell className="text-right tabular">{number(totals.clicks)}</TableCell>
              <TableCell className="text-right tabular">{percent(totals.ctr)}</TableCell>
              <TableCell className="text-right tabular">{number(totals.conversions, { decimals: 1 })}</TableCell>
              <TableCell className="text-right tabular">{money(totals.cpa, currency, { decimals: 0 })}</TableCell>
              <TableCell className="pr-4 text-right font-semibold tabular">{multiple(totals.roas)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {selectedIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-30 flex justify-center px-4 animate-fade-up">
          <div className="flex items-center gap-1 rounded-xl border bg-popover p-1.5 pl-4 shadow-xl">
            <span className="mr-2 text-sm font-medium tabular">{selectedIds.length} selected</span>
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => runBulk("PAUSED")}>
              <Pause /> Pause
            </Button>
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => runBulk("ACTIVE")}>
              <Play /> Activate
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" onClick={() => setSelection({})} aria-label="Clear selection">
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear selection</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      <BudgetDialog campaign={editing} workspaceId={workspaceId} onOpenChange={(o) => !o && setEditing(null)} />
    </>
  );
}
