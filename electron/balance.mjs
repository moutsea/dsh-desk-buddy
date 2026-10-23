export function createBalanceRefresher({ client, state, broadcast }) {
  let revision = 0;
  return async function refreshBalance() {
    const row = client.entries.get("dsh");
    if (row?.status !== "connected") return;
    const epoch = row.epoch,
      request = ++revision;
    // The multiplexer survives connection changes. Reconnects reuse the row,
    // so bind both results and errors to its epoch and the latest request.
    const current = () =>
      client.current(row) &&
      row.epoch === epoch &&
      row.status === "connected" &&
      revision === request;
    try {
      const result = await client.balance();
      if (!current()) return;
      if (!result.ok) throw new Error(result.error || "无法读取余额");
      if (
        !Array.isArray(result.balances) ||
        !result.balances.length ||
        result.balances.some(
          (row) =>
            !Number.isFinite(row.total) ||
            !["CNY", "USD"].includes(row.currency),
        )
      )
        throw new Error("余额响应格式不兼容");
      state.balance = result;
      state.balanceError = result.stale ? result.error || "当前为旧数据" : "";
    } catch (error) {
      if (!current()) return;
      state.balanceError = /404/.test(error.message)
        ? "尚未安装余额插件"
        : error.message;
    }
    broadcast();
  };
}
