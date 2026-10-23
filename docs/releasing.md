# 发布流程

发布采用“候选包验证 → 生成清单 → 提交清单并打标签 → 发布原成品”的顺序。标签推送只触发验证，不再自动创建 Release。不要在清单提交后重新构建并拿新包替换已验证的成品；打包时间等差异会改变 SHA-256。

1. 同步根目录、锁文件和 `plugins/dsh-girl/package.json` 的版本，更新发布说明、README 和接入文档。完成 Windows 人工悬停检查（见 [平台验证](platforms.md)）。提交后在该提交运行 **Desktop validation**，等待 Windows x64 与 macOS ARM64 全部通过。候选阶段清单可以仍指向上版，完整包不使用此清单；此阶段不要分发仓库源码入口。
2. 记录这次成功运行的 ID，在干净工作区下载它上传的两个 `dsh-desk-buddy-*` 成品到同一个目录。例如 `release-candidate/`（放在仓库外或加入本地忽略）。使用该运行的提交作为工作区基础，运行：

   ```sh
   node scripts/release-manifest.mjs write /absolute/path/to/release-candidate
   node scripts/release-manifest.mjs check /absolute/path/to/release-candidate
   ```

   脚本检查两平台包名、插件版本、运行时版本和平台，并从实际文件计算 SHA-256。不能手填虚构哈希，也不能拿不同构建的包混用。
3. **仅提交** `plugins/dsh-girl/release-runtime.json` 的生成结果，然后在该提交打 `v<version>` 标签并推送。若还需修改代码、文档、版本或工作流，先返回第 1 步重新验证候选。
4. 手动运行 **Publish verified build**，填写该标签和第 1 步的运行 ID。工作流验证：候选运行成功；候选是标签提交的祖先；除生成清单外，源码树完全一致；标签与包版本一致；清单与两个下载成品的元数据和哈希完全一致。通过后发布这些原成品和 `SHA256SUMS.txt`。
5. 发布后执行 `DSG_REPOSITORY_REMOTE=1 npm run test:repository`，检查实际 GitHub 下载和启动。保留两平台的 `desktop-evidence-*` 与候选运行记录。

`test:repository` 默认在隔离安装目录写入本轮候选清单，用测试进程内的下载替身提供本地 `.tgz`，完整执行下载校验、解压、原生启动、控制与缓存重启。这解决了发布前远程附件尚不存在的问题，不改写仓库里的正式清单。`test:packaged` 包含 Codex 与双平台离线 smoke，两个 CI 平台都运行。

已发布的旧标签不移动。旧版清单错配通过下一版本修正；当前安装器会明确拒绝错配，不再静默启动错误版本。
