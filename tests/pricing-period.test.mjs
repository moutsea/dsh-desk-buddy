import test from "node:test";
import assert from "node:assert/strict";
import { deepseekPricingPeriod } from "../shared/pricing-period.mjs";

const at = (date, time) =>
  deepseekPricingPeriod(Date.parse(`${date}T${time}+08:00`));

test("pricing periods follow Beijing time with exact morning and afternoon boundaries", () => {
  for (const [time, expected] of [
    ["00:00:00", "off-peak"],
    ["08:59:59.999", "off-peak"],
    ["09:00:00", "peak"],
    ["11:59:59.999", "peak"],
    ["12:00:00", "off-peak"],
    ["13:59:59.999", "off-peak"],
    ["14:00:00", "peak"],
    ["17:59:59.999", "peak"],
    ["18:00:00", "off-peak"],
    ["23:59:59.999", "off-peak"],
  ]) {
    assert.equal(at("2026-10-19", time).id, expected, time);
  }
  assert.equal(
    deepseekPricingPeriod(Date.parse("2026-10-19T01:00:00Z")).id,
    "peak",
  );
  assert.equal(
    deepseekPricingPeriod(Date.parse("2026-10-18T17:00:00-08:00")).id,
    "peak",
  );
  assert.equal(at("2026-10-19", "09:00:00").label, "峰时");
  assert.match(at("2026-10-19", "09:00:00").description, /北京时间 09:00/);
});

test("weekends, holiday weekdays and weekend makeup workdays remain off-peak", () => {
  for (const date of [
    "2026-01-02",
    "2026-02-16",
    "2026-02-23",
    "2026-04-06",
    "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-01",
    "2026-10-07",
    "2026-10-17",
    "2026-10-18",
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
  ]) {
    for (const time of ["10:00:00", "15:00:00"])
      assert.equal(at(date, time).label, "谷时", `${date} ${time}`);
  }
  for (const date of ["2026-02-24", "2026-10-08"])
    assert.equal(at(date, "10:00:00").label, "峰时", date);
  // UTC Sunday is already Beijing Monday.
  assert.equal(
    deepseekPricingPeriod(Date.parse("2026-10-18T16:00:00Z")).label,
    "谷时",
  );
});

test("unavailable annual holiday calendars are disclosed instead of claiming certainty", () => {
  const estimated = at("2027-10-01", "10:00:00");
  assert.equal(estimated.label, "峰时·估算");
  assert.match(estimated.description, /2027 年节假日日历尚未收录/);
  assert.equal(at("2027-10-02", "10:00:00").label, "谷时");
  assert.equal(at("2027-10-01", "20:00:00").label, "谷时");
});
