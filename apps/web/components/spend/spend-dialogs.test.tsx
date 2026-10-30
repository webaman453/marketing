import { describe, expect, it } from "vitest";
import { parseAmount } from "./spend-dialogs";

describe("parseAmount", () => {
  it("reads amounts with or without separators, to the cent", () => {
    expect(parseAmount("50000")).toBe(50000);
    expect(parseAmount("50,000")).toBe(50000);
    expect(parseAmount(" 1 25 000.456 ")).toBe(125000.46);
  });

  it("is null for blank, zero, negative and non-numbers", () => {
    for (const raw of ["", "   ", "0", "-10", "abc", "1e400"]) expect(parseAmount(raw)).toBeNull();
  });
});
