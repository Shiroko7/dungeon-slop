import { expect, test } from "bun:test";
import { jsPDF } from "jspdf";
import { geometry } from "../test-fixtures.ts";
import { exportDescriptionsPDF } from "./descriptions-export.ts";

test("description export produces a real PDF with the upgraded jsPDF", () => {
  const api = jsPDF.API as typeof jsPDF.API & {
    save?: (this: jsPDF, name: string) => jsPDF;
  };
  const originalSave = api.save;
  let document = "";
  let filename = "";
  api.save = function (this: jsPDF, name: string) {
    document = this.output();
    filename = name;
    return this;
  };
  try {
    exportDescriptionsPDF(geometry(), new Map([[0, {
      name: "Security upgrade smoke room",
      description: "A room exported using the production PDF formatter.",
      monsters: ["Goblin"],
      treasure: ["Gold"],
    }]]));
    expect(filename).toBe("dungeon-42-descriptions.pdf");
    expect(document.startsWith("%PDF-")).toBe(true);
    expect(document).toContain("Security upgrade smoke room");
    expect(document).toContain("%%EOF");
  } finally {
    if (originalSave) api.save = originalSave;
    else delete api.save;
  }
});
