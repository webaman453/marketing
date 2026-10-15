import { prisma, type Prisma } from "@ashniva/db";

export interface AuditEntry {
  orgId: string;
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityName?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }>;
  ip?: string | null;
}

/** Records who changed what. Failures are logged, never thrown, so they cannot break the action itself. */
export async function audit(entry: AuditEntry, tx: Prisma.TransactionClient = prisma) {
  try {
    await tx.auditLog.create({
      data: {
        ...entry,
        changes: entry.changes as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.error("[audit] failed to write entry", entry.action, err);
  }
}
