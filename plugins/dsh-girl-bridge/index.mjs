export const name = "dsh-girl-bridge";
export const inject = ["webServer", "credentials"];

export function createBalanceReader(
  credentials,
  fetcher = fetch,
  now = Date.now,
) {
  let cache = null,
    inFlight = null;
  return async function read() {
    if (cache && now() - cache.updatedAt < 60000) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const credential = await credentials.resolve("DEEPSEEK_API_KEY");
        if (!credential?.value)
          return {
            ok: false,
            code: "NO_KEY",
            error: "DSH 尚未配置 DEEPSEEK_API_KEY",
          };
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await fetcher("https://api.deepseek.com/user/balance", {
              headers: { Authorization: `Bearer ${credential.value}` },
              signal: AbortSignal.timeout(12000),
              redirect: "error",
            });
            if (response.status >= 500 && attempt === 0) {
              await response.body?.cancel();
              continue;
            }
            break;
          } catch (error) {
            if (attempt === 1) throw error;
          }
        }
        if (!response?.ok)
          return {
            ok: false,
            code: "UPSTREAM",
            error: `DeepSeek 余额查询失败（HTTP ${response?.status || "未知"}）`,
          };
        const body = await response.json();
        const balances = (body.balance_infos || []).map((row) => ({
          currency: row.currency,
          total: Number(row.total_balance),
          granted: Number(row.granted_balance),
          toppedUp: Number(row.topped_up_balance),
        }));
        if (
          !balances.length ||
          balances.some(
            (row) =>
              !Number.isFinite(row.total) ||
              !["CNY", "USD"].includes(row.currency),
          )
        )
          throw new Error("invalid balance");
        cache = {
          ok: true,
          balances,
          available: body.is_available,
          accountLabel: "DeepSeek Key 账号",
          updatedAt: now(),
        };
        return cache;
      } catch {
        return {
          ok: false,
          code: "UNAVAILABLE",
          error: "暂时无法查询 DeepSeek 余额，请稍后重试",
        };
      }
    })()
      .then((result) =>
        !result.ok && cache
          ? { ...cache, stale: true, error: result.error }
          : result,
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export function apply(ctx) {
  const read = createBalanceReader(ctx.credentials);
  const dispose = ctx.webServer.register({
    kind: "exact",
    path: "/dsh-girl/balance.json",
    handler: async (req, res) => {
      const origin = req.headers?.origin;
      // Match DSH's local-only use; a browser from another origin must not read account metadata.
      let sameOrigin = true;
      try {
        const authority = new URL("http://" + req.headers?.host);
        sameOrigin =
          ["127.0.0.1", "[::1]", "localhost"].includes(authority.hostname) &&
          req.headers?.["sec-fetch-site"] !== "cross-site";
        if (origin)
          sameOrigin =
            sameOrigin && new URL(origin).origin === authority.origin;
      } catch {
        sameOrigin = false;
      }
      if (req.method !== "GET" || !sameOrigin) {
        res.writeHead(req.method !== "GET" ? 405 : 403);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(await read()));
    },
  });
  ctx.effect(() => dispose);
}

export default { name, inject, apply };
