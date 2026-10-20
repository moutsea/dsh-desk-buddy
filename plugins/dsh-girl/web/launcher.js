if (!document.querySelector("deepseek-girl-manager")) {
  const host = document.createElement("deepseek-girl-manager");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{position:fixed;bottom:18px;left:18px;z-index:2147483000;font:12px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}button{display:flex;align-items:center;gap:7px;border:1px solid #cbdcf3;border-radius:15px;background:#f4f8fff5;color:#6380ae;padding:7px 12px;cursor:pointer;box-shadow:0 3px 12px #34527a12}button img{width:24px;height:24px;border-radius:6px}iframe{position:absolute;left:0;bottom:48px;width:min(400px,calc(100vw - 36px));height:min(760px,calc(100vh - 90px));border:1px solid #d5e1f3;border-radius:20px;background:#f7f9ff;box-shadow:0 8px 35px #344b7420}button:focus-visible{outline:2px solid #8aabda;outline-offset:3px}";
  const button = document.createElement("button");
  button.textContent = "dsh-desk-buddy";
  const icon = document.createElement("img");
  icon.src = "/dsh-girl/icon.png";
  icon.alt = "";
  button.prepend(icon);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "dsg-management");
  let frame;
  button.onclick = () => {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "dsg-management";
      frame.src = "/dsh-girl/";
      frame.title = "dsh-desk-buddy 桌宠管理";
      root.prepend(frame);
    } else frame.hidden = !frame.hidden;
    button.setAttribute("aria-expanded", String(!frame.hidden));
  };
  root.append(style, button);
  document.body.append(host);
}
