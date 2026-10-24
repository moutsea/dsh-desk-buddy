import { expect } from "@playwright/test";

export async function openSoundEvents(page) {
  const dialog = page.getByRole("dialog", {
    name: "互动声音设置",
    exact: true,
  });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: /^互动声音设置/ }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeSoundEvents(page) {
  const dialog = page.getByRole("dialog", {
    name: "互动声音设置",
    exact: true,
  });
  await dialog.getByRole("button", { name: "关闭互动声音设置" }).click();
  await expect(dialog).not.toBeVisible();
}
