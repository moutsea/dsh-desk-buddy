// DeepSeek official API pricing, checked 2026-10-18:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Holiday calendar: 国办发明电〔2025〕7号
// https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
const holidays = {
  2026: [
    ["01-01", "01-03"],
    ["02-15", "02-23"],
    ["04-04", "04-06"],
    ["05-01", "05-05"],
    ["06-19", "06-21"],
    ["09-25", "09-27"],
    ["10-01", "10-07"],
  ],
};

export function deepseekPricingPeriod(now = Date.now()) {
  // UTC getters on a shifted timestamp keep this independent of the OS timezone.
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const date = beijing.toISOString().slice(5, 10);
  const weekday = beijing.getUTCDay();
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const calendar = holidays[year];
  const holiday = calendar?.some(
    ([start, end]) => date >= start && date <= end,
  );
  // DeepSeek explicitly treats weekends as off-peak, including makeup workdays.
  const peak =
    weekday >= 1 &&
    weekday <= 5 &&
    !holiday &&
    ((minutes >= 9 * 60 && minutes < 12 * 60) ||
      (minutes >= 14 * 60 && minutes < 18 * 60));
  const estimated = peak && !calendar;
  const label = peak ? (estimated ? "峰时·估算" : "峰时") : "谷时";
  return {
    id: peak ? "peak" : "off-peak",
    label,
    description: [
      `当前${label}（北京时间 ${beijing.toISOString().slice(11, 16)}）`,
      "峰时：周一至周五 09:00–12:00、14:00–18:00；周末、节假日和其余时段为谷时。",
      estimated ? `${year} 年节假日日历尚未收录，当前按周一至周五估算。` : "",
      "适用于 DeepSeek 官方 API。",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
