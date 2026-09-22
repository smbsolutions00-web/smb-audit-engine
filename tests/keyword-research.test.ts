import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreSaleKeywordMatrix,
  selectPreSaleOpportunities,
  type ResearchCandidate,
} from "../server/audit-engine";

test("pre-sale matrix includes city forms and near-me only for the home city", () => {
  const rows = buildPreSaleKeywordMatrix(
    ["emergency plumber", "water heater repair"],
    [
      { city: "Frisco", state: "TX", geoLayer: "local" },
      { city: "Plano", state: "TX", geoLayer: "adjacent" },
    ],
  );

  assert.ok(rows.some((row) => row.keyword === "emergency plumber frisco"));
  assert.ok(rows.some((row) => row.keyword === "emergency plumber in plano"));
  assert.ok(rows.some((row) => row.keyword === "water heater repair near me"));
  assert.equal(rows.filter((row) => row.keyword.endsWith("near me")).length, 2);
});

test("opportunity selection excludes unmeasured and sub-threshold rows", () => {
  const rows: ResearchCandidate[] = [
    { keyword: "plumber frisco", market: "Frisco", serviceTheme: "plumber", volume: 90 },
    { keyword: "plumber plano", market: "Plano", serviceTheme: "plumber", volume: 4 },
    { keyword: "plumber mckinney", market: "McKinney", serviceTheme: "plumber" },
    { keyword: "water heater repair frisco", market: "Frisco", serviceTheme: "water heater repair", volume: 20 },
  ];

  assert.deepEqual(
    selectPreSaleOpportunities(rows).map((row) => row.keyword),
    ["plumber frisco", "water heater repair frisco"],
  );
});

test("opportunity selection follows the largest share of measured volume", () => {
  const rows: ResearchCandidate[] = Array.from({ length: 20 }, (_, index) => ({
    keyword: `service ${index + 1}`,
    market: "Frisco",
    serviceTheme: "service",
    volume: 100 - index * 4,
  }));
  const selected = selectPreSaleOpportunities(rows, 15, 5);
  assert.ok(selected.length >= 8);
  assert.ok(selected.length <= 15);
  assert.equal(selected[0].volume, 100);
  assert.ok(selected.every((row) => (row.volume || 0) >= 5));
});
