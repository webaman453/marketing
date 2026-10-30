import { emptyContext, type Field, type FieldContext } from "@ashniva/shared";
import { useState } from "react";
import { vi } from "vitest";
import type { BuilderEnv } from "@/components/builder/builder-context";
import { FieldRenderer } from "@/components/builder/fields";
import { renderWithBuilder } from "./render";

/** Keeps a field's value in state like the builder does, and records every change. */
function Controlled({ field, initial, ctx, errors, spy }: { field: Field; initial: unknown; ctx: FieldContext; errors: string[]; spy: (v: unknown) => void }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <FieldRenderer
      field={field}
      value={value}
      ctx={ctx}
      errors={errors}
      onChange={(v) => {
        spy(v);
        setValue(v);
      }}
    />
  );
}

export function renderField(field: Field, o: { value?: unknown; ctx?: Partial<FieldContext>; errors?: string[]; env?: Partial<BuilderEnv> } = {}) {
  const onChange = vi.fn();
  const ctx = { ...emptyContext(), ...o.ctx };
  const utils = renderWithBuilder(<Controlled field={field} initial={o.value} ctx={ctx} errors={o.errors ?? []} spy={onChange} />, o.env);
  /** The most recent value passed to onChange. */
  const last = () => onChange.mock.calls.at(-1)?.[0];
  return { ...utils, onChange, last };
}
