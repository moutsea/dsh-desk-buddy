export function toolPresentation(data = {}) {
  const name = typeof data.name === "string" ? data.name : "工具";
  let args = data.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {}
  }
  const formatted =
    typeof args === "string"
      ? args
      : args == null
        ? ""
        : JSON.stringify(args, null, 2);
  const fields = args && typeof args === "object" ? args : {};
  const value = [
    fields.command,
    fields.cmd,
    fields.script,
    fields.path,
    fields.file_path,
    fields.filePath,
    fields.query,
    fields.pattern,
    fields.url,
  ].find((item) => typeof item === "string" || Array.isArray(item));
  const detail = Array.isArray(value)
    ? value.filter((item) => typeof item === "string").join(" ")
    : value || formatted;
  return { name, detail, arguments: formatted };
}
