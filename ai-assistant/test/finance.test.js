import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInvestment, irr, npv } from "../public/shared/finance.js";

const base = {
  title: "KenCity 15대",
  years: 5,
  investment_items: [
    { label: "냉동 컨테이너 15대", quantity: 15, unit_cost: 70000 },
    { label: "부대비용", amount: 200000 },
  ],
  annual_revenue: { amount: 720000 },
  annual_opex: { amount: 430000 },
};

test("시안의 수치로 계산하면 회수기간은 3.2년이 아니라 약 4.3년이다", () => {
  const r = computeInvestment(base);
  assert.equal(r.totalInvestment, 1_250_000);
  assert.equal(r.avgNet, 290_000);
  assert.ok(Math.abs(r.paybackYears - 1_250_000 / 290_000) < 1e-9);
  assert.equal(r.paybackYears.toFixed(1), "4.3");
  assert.deepEqual(
    r.rows.map((row) => row.cumulative),
    [-1_250_000, -960_000, -670_000, -380_000, -90_000, 200_000],
  );
  assert.equal(r.roi.toFixed(2), "0.16"); // (290,000×5 − 1,250,000) / 1,250,000
});

test("수량을 25대로 바꾸면 투자비가 단가만큼 늘어난다", () => {
  const r = computeInvestment({ ...base, investment_items: [{ ...base.investment_items[0], quantity: 25 }, base.investment_items[1]] });
  assert.equal(r.totalInvestment, 25 * 70000 + 200000);
});

test("기간 안에 회수되지 않으면 회수기간은 null", () => {
  const r = computeInvestment({ ...base, years: 3 });
  assert.equal(r.paybackYears, null);
});

test("연차별 매출이 주어지면 그 값을 쓴다", () => {
  const r = computeInvestment({ ...base, revenue_by_year: [430000, 720000] });
  assert.equal(r.rows[1].net, 0);
  assert.equal(r.rows[2].net, 290000);
  assert.equal(r.variesByYear, true);
});

test("IRR에서 NPV는 0이 된다", () => {
  const flows = [-1_250_000, 290_000, 290_000, 290_000, 290_000, 290_000];
  const rate = irr(flows);
  assert.ok(rate > 0.04 && rate < 0.07);
  assert.ok(Math.abs(npv(flows, rate)) < 0.01);
});

test("할인율이 있으면 NPV를 계산한다", () => {
  const r = computeInvestment({ ...base, discount_rate: 0.1 });
  assert.ok(r.npv < 0); // 10%면 5년 안에 수익성이 나지 않음
});
