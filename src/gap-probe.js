/**
 * Windows UI Automation（UIA）任务栏按钮探测模块。
 *
 * 零 Electron / `koffi` 依赖：通过短生命周期 `powershell.exe` 进程读取目标任务栏内
 * 所有按钮的屏幕矩形、任务栏对齐设置（`TaskbarAl`）、系统浅色主题设置与 OS 构建号，
 * 并以 JSON 形式返回。所有脚本拼装与输出解析函数均导出，可在任意平台直接单测。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$hwndValue = __TASKBAR_HWND__
$taskbar = $null
if ($hwndValue -gt 0) {
  # 指定了任务栏 HWND（含副屏 Shell_SecondaryTrayWnd）时直接按句柄查找，
  # 不可回退到按类名找主任务栏，避免跨屏读错按钮坐标。
  try {
    $taskbar = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwndValue)
  } catch {
    $taskbar = $null
  }
} else {
  $classCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
  $taskbar = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $classCondition)
}
$taskbarFound = $null -ne $taskbar

$buttons = @()
if ($taskbarFound) {
  $buttonCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
  $found = $taskbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  foreach ($element in $found) {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -gt 1) {
      $buttons += @{
        x = [int]$rect.X
        y = [int]$rect.Y
        w = [int]$rect.Width
        h = [int]$rect.Height
      }
    }
  }
}

$advanced = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -ErrorAction SilentlyContinue
$al = $null
if ($null -ne $advanced -and $null -ne $advanced.TaskbarAl) {
  $al = [int]$advanced.TaskbarAl
}

$personalize = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$light = $null
if ($null -ne $personalize -and $null -ne $personalize.SystemUsesLightTheme) {
  $light = [int]$personalize.SystemUsesLightTheme
}

$build = [Environment]::OSVersion.Version.Build

@{ buttons = @($buttons); taskbarFound = $taskbarFound; taskbarAl = $al; lightTaskbar = $light; osBuild = [int]$build } | ConvertTo-Json -Compress -Depth 4
`;

/**
 * 生成 PowerShell 探测脚本。唯一插值参数为校验过的安全正整数十进制 HWND（`0` 表示查找主任务栏），
 * 杜绝脚本注入风险。
 *
 * @param {number | bigint} [taskbarHwnd=0]
 * @returns {string}
 */
export function buildProbeScript(taskbarHwnd = 0) {
  const numeric = Number(taskbarHwnd);
  const safeHwnd = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  return PROBE_SCRIPT.replaceAll('__TASKBAR_HWND__', String(safeHwnd));
}

/** 将脚本文本编码为 `powershell.exe -EncodedCommand` 所需的 UTF-16LE Base64 字符串。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 解析探测脚本的标准输出 JSON。
 * 当输出非法、`taskbarFound === false` 或按钮结构不完整时返回 `null`，
 * 避免把「找不到任务栏」误判成「整条任务栏都是空档」。
 *
 * @param {string} stdout
 * @returns {{
 *   buttons: Array<{ x: number, y: number, w: number, h: number }>,
 *   taskbarAl: number | null,
 *   lightTaskbar: boolean | null,
 *   osBuild: number
 * } | null}
 */
export function parseProbeOutput(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.taskbarFound === false) return null;
  if (!Array.isArray(data.buttons)) return null;
  if (!isFiniteNumber(data.osBuild)) return null;

  const buttons = [];
  for (const button of data.buttons) {
    if (!button || typeof button !== 'object') return null;
    if (
      !isFiniteNumber(button.x) ||
      !isFiniteNumber(button.y) ||
      !isFiniteNumber(button.w) ||
      !isFiniteNumber(button.h)
    ) {
      return null;
    }
    buttons.push({
      x: Math.trunc(button.x),
      y: Math.trunc(button.y),
      w: Math.trunc(button.w),
      h: Math.trunc(button.h),
    });
  }

  const taskbarAl = isFiniteNumber(data.taskbarAl) ? data.taskbarAl : null;
  const lightTaskbar =
    data.lightTaskbar === null || data.lightTaskbar === undefined ? null : data.lightTaskbar === 1;

  return { buttons, taskbarAl, lightTaskbar, osBuild: Math.trunc(data.osBuild) };
}

function resolvePowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot) return null;
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 在当前机器上执行一次异步任务栏 UIA 探测。
 * 非 Windows 平台、缺少 `powershell.exe`、超时或解析失败均安全 resolve 为 `null`。
 *
 * @param {{ taskbarHwnd?: number | bigint, timeoutMs?: number }} [options]
 */
export function probeTaskbar({ taskbarHwnd = 0, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    const powershell = resolvePowerShellPath();
    if (!powershell || !existsSync(powershell)) {
      resolve(null);
      return;
    }

    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(buildProbeScript(taskbarHwnd)),
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseProbeOutput(stdout));
      }
    );
  });
}
