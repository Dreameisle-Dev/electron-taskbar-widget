# 贡献指南（Contributing）

## 反馈兼容性问题（Issue）

Windows 任务栏行为高度依赖系统版本、缩放比与多屏配置。提交 Issue 时请尽量提供：

1. Windows 版本与构建号（可在终端运行 `winver` 或查看 `os.release()`）；
2. 显示器数量、各屏分辨率与 DPI 缩放、任务栏位置与对齐方式（居中/左对齐）；
3. 是否安装了第三方任务栏工具（如 ExplorerPatcher、StartAllBack、Windhawk 等）；
4. 通过 `logger` 回调采集的诊断日志与现象截图。

## 提交 Pull Request

```bash
npm test
```

要求：

1. 纯几何逻辑留在 `src/layout.js`，不要引入 Electron 或原生绑定，确保跨平台可单测；
2. Win32 高频轮询调用不得在循环内持续分配未释放的原生内存；
3. 新增布局规则、边界修复或解析调整须附带对应的 `node --test` 用例。
