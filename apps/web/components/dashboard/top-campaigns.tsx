import type { CampaignRowDTO } from "@ashniva/shared";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { StatusDot } from "@/components/metrics";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, multiple, number } from "@/lib/format";

export function TopCampaigns({
  campaigns,
  workspaceId,
  currency,
}: {
  campaigns: CampaignRowDTO[];
  workspaceId: string;
  currency: string;
}) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Top campaigns</CardTitle>
        <CardDescription>Highest spend in the selected period</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <Link href={`/w/${workspaceId}/campaigns`}>
              View all <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[42%] pl-4">Campaign</TableHead>
              <TableHead className="hidden md:table-cell">Status</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Conv.</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Cost / conv.</TableHead>
              <TableHead className="pr-4 text-right">ROAS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={c.id} className="group">
                <TableCell className="w-[42%] max-w-0 pl-4">
                  <Link href={`/w/${workspaceId}/campaigns/${c.id}`} className="flex min-w-0 items-center gap-2.5">
                    <PlatformIcon platform={c.platform} size="sm" />
                    <span className="truncate font-medium group-hover:text-primary group-hover:underline group-hover:underline-offset-4">
                      {c.name}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <StatusDot status={c.status} />
                </TableCell>
                <TableCell className="text-right font-medium tabular">{money(c.metrics.spend, currency)}</TableCell>
                <TableCell className="hidden text-right tabular sm:table-cell">{number(c.metrics.conversions, { decimals: 0 })}</TableCell>
                <TableCell className="hidden text-right tabular lg:table-cell">{money(c.metrics.cpa, currency, { decimals: 0 })}</TableCell>
                <TableCell className="pr-4 text-right tabular">{multiple(c.metrics.roas)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
