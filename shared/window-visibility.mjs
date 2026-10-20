// Subscribe before requesting the initial snapshot. A later native event
// supersedes that snapshot even if its IPC reply arrives afterwards.
export function observeWindowVisibility(desktop, changed) {
  let live = true;
  let revision = 0;
  const unsubscribe = desktop?.subscribeVisibility?.((visible) => {
    if (!live) return;
    revision++;
    changed(visible);
  });
  const requestedAt = revision;
  void desktop
    ?.invoke("visibility")
    .then((visible) => {
      if (live && revision === requestedAt) changed(visible);
    })
    .catch(() => {});
  return () => {
    live = false;
    unsubscribe?.();
  };
}
