// 투자비·현금흐름 계산 (서버와 브라우저가 같은 코드를 씁니다).
// 숫자는 AI가 암산하지 않고 항상 이 함수로 계산합니다.

/**
 * @typedef {{ label: string, amount?: number, quantity?: number, unit_cost?: number, source?: string }} InvestmentItem
 * @typedef {{ amount: number, source?: string, label?: string }} AnnualValue
 * @typedef {{
 *   title?: string, currency?: string, years: number,
 *   investment_items: InvestmentItem[],
 *   annual_revenue: AnnualValue, annual_opex: AnnualValue,
 *   revenue_by_year?: number[], opex_by_year?: number[],
 *   discount_rate?: number | null,
 * }} InvestmentInput
 */

export const MAX_YEARS = 30;

/** 투자 항목 금액: 수량 × 단가가 있으면 그것을, 없으면 amount를 씁니다. */
export function itemAmount(item) {
  if (isNum(item.quantity) && isNum(item.unit_cost)) return item.quantity * item.unit_cost;
  return isNum(item.amount) ? item.amount : 0;
}

/**
 * 0년차에 초기 투자, 1~N년차에 운영 현금흐름이 발생한다고 보고 계산합니다(세전).
 * @param {InvestmentInput} input
 */
export function computeInvestment(input) {
  const years = Math.min(MAX_YEARS, Math.max(1, Math.round(input.years)));
  const items = input.investment_items.map((it) => ({ ...it, amount: itemAmount(it) }));
  const totalInvestment = sum(items.map((it) => it.amount));

  const revenueByYear = perYear(input.revenue_by_year, input.annual_revenue.amount, years);
  const opexByYear = perYear(input.opex_by_year, input.annual_opex.amount, years);

  const rows = [{ year: 0, revenue: 0, opex: 0, investment: totalInvestment, net: -totalInvestment, cumulative: -totalInvestment }];
  let cumulative = -totalInvestment;
  for (let y = 1; y <= years; y++) {
    const net = revenueByYear[y - 1] - opexByYear[y - 1];
    cumulative += net;
    rows.push({ year: y, revenue: revenueByYear[y - 1], opex: opexByYear[y - 1], investment: 0, net, cumulative });
  }

  const operatingNet = rows.slice(1).map((r) => r.net);
  const totalNet = sum(operatingNet);
  const discountRate = isNum(input.discount_rate) ? input.discount_rate : null;
  const flows = rows.map((r) => r.net);

  return {
    years,
    currency: input.currency || "USD",
    items,
    totalInvestment,
    avgRevenue: sum(revenueByYear) / years,
    avgOpex: sum(opexByYear) / years,
    avgNet: totalNet / years,
    variesByYear: !allEqual(revenueByYear) || !allEqual(opexByYear),
    rows,
    paybackYears: paybackPeriod(rows),
    roi: totalInvestment > 0 ? (totalNet - totalInvestment) / totalInvestment : null,
    discountRate,
    npv: discountRate === null ? null : npv(flows, discountRate),
    irr: irr(flows),
  };
}

/** 누적 현금흐름이 처음 0 이상이 되는 시점(연 단위, 연중 균등 발생 가정으로 보간). */
export function paybackPeriod(rows) {
  if (rows[0].cumulative >= 0) return 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].cumulative >= 0 && rows[i].net > 0) {
      return rows[i - 1].year + -rows[i - 1].cumulative / rows[i].net;
    }
  }
  return null; // 분석 기간 안에 회수되지 않음
}

export function npv(flows, rate) {
  return flows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}

/** 이분법으로 IRR을 구합니다. 부호가 바뀌지 않으면 null. */
export function irr(flows) {
  let lo = -0.99;
  let hi = 10;
  let fLo = npv(flows, lo);
  const fHi = npv(flows, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(flows, mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

function perYear(overrides, fallback, years) {
  return Array.from({ length: years }, (_, i) => (Array.isArray(overrides) && isNum(overrides[i]) ? overrides[i] : fallback));
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function allEqual(values) {
  return values.every((v) => v === values[0]);
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}
