import { describe, expect, it } from "vitest";
import { csvCell } from "@/app/api/admin/export/messages/route";

describe("CSV export escaping", () => {
  it.each(["=1+1", "+SUM(A1:A2)", "-1+2", "@SUM(A1:A2)", "\t=1+1", "  =1+1"])("neutralizes spreadsheet formulas beginning with %j", value => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });

  it("retains ordinary CSV quoting", () => {
    expect(csvCell('A "quoted" subject')).toBe('"A ""quoted"" subject"');
  });
});
