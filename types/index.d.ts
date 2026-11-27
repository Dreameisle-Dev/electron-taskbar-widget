export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskbarMetrics {
  screenLeft: number;
  screenTop: number;
  clientWidth: number;
  clientHeight: number;
  vertical: boolean;
  dpiScale: number;
  windowRect: Rect;
}

export interface WindowStyleInfo {
  style: string;
  exStyle: string;
  popup: boolean;
  child: boolean;
  layered: boolean;
  topmost: boolean;
  toolWindow: boolean;
  noActivate: boolean;
}

export interface ProbeButton {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProbeResult {
  buttons: ProbeButton[];
  taskbarAl: number | null;
  lightTaskbar: boolean | null;
  osBuild: number;
}

export interface GapRange {
  left: number;
  right: number;
}

export interface LegacyLayoutResult {
  strip: Bounds;
  taskList: Bounds | null;
}

export interface TaskbarWidgetState {
  enabled: boolean;
  running: boolean;
  visible: boolean;
  vertical: boolean;
  align: 'start' | 'end';
  lightTaskbar: boolean;
  legacy: boolean;
  fullscreen: boolean;
}

export interface CreateTaskbarWidgetOptions {
  htmlPath?: string | null;
  load?: ((win: unknown) => void) | null;
  preload?: string;
  webPreferences?: Record<string, unknown>;
  ignoreMouseEvents?: boolean;
  fixedLengthCss?: number | null;
  initialWidthCss?: number;
  fallbackMarginCss?: number;
  recreateDelayMs?: number;
  pollIntervalMs?: number;
  fullscreenIntervalMs?: number;
  probeHeartbeatMs?: number;
  probeDebounceMs?: number;
  minProbeIntervalMs?: number;
  metricsRecreateDelayMs?: number;
  initialHasContent?: boolean;
  getOwnerWindow?: (() => unknown | null) | null;
  hardenWindow?: ((webContents: unknown, htmlPath: string | null) => void) | null;
  logger?: ((message: string, details?: Record<string, unknown> | null) => void) | null;
  onEmbedded?: ((ctx: { win: unknown; state: TaskbarWidgetState }) => void) | null;
  onStateChange?: ((state: TaskbarWidgetState) => void) | null;
  onEnableFailed?: ((error: Error, ctx: { notifyUser: boolean }) => void) | null;
  electron?: { BrowserWindow: unknown; screen: unknown } | null;
}

export interface TaskbarWidgetHost {
  enable(options?: { notifyUser?: boolean }): boolean;
  disable(): void;
  dispose(): void;
  isEnabled(): boolean;
  isRunning(): boolean;
  isVisible(): boolean;
  getWindow(): unknown | null;
  getState(): TaskbarWidgetState;
  setHasContent(value: boolean): void;
  setContentWidth(px: number): void;
  send(channel: string, payload?: unknown): void;
  refresh(): Promise<boolean>;
}

export interface LegacyLayoutController {
  isUsable(): boolean;
  apply(params: { trayHwnd: bigint; widthCss: number }):
    | {
        ok: true;
        bounds: Bounds;
        stripLengthPx: number;
        contentLengthPx: number;
        vertical: boolean;
        taskListMoved: boolean;
      }
    | {
        ok: false;
        reason: 'unsupported' | 'waiting' | 'retry' | 'no-space' | 'move-failed';
      };
  restore(): void;
  reset(): void;
}

export declare const MIN_TEXT_CSS: number;
export declare const WINDOW_PADDING_CSS: number;
export declare const MIN_WINDOW_CSS: number;
export declare const DOCK_MARGIN_CSS: number;
export declare const MIN_GAP_CSS: number;
export declare const FIXED_STRIP_CSS: number;

export declare function createTaskbarWidget(options?: CreateTaskbarWidgetOptions): TaskbarWidgetHost;

export declare function createLegacyLayoutController(options?: {
  logger?: ((message: string, details?: Record<string, unknown> | null) => void) | null;
  fixedStripCss?: number;
  dockMarginCss?: number;
}): LegacyLayoutController;

export declare function isLegacyWindows(): boolean;

export declare function sideFor(params: {
  osBuild: number;
  taskbarAl?: number | null;
}): 'left' | 'right';

export declare function shouldShow(params: {
  enabled: boolean;
  hasContent?: boolean;
  hasSong?: boolean;
  fullscreen: boolean;
  hasGap: boolean;
  hasFallback: boolean;
  windowAlive: boolean;
}): boolean;

export declare function shouldCoalesceProbe(
  inFlightKey: string | null | undefined,
  requestedKey: string | null | undefined
): boolean;

export declare function computeLegacyTaskbarLayout(params: {
  rebarClientOrigin: { x: number; y: number };
  rebarClientSize: { width: number; height: number };
  taskbarClientOrigin: { x: number; y: number };
  taskListRect?: Rect | null;
  stripWidthPx: number;
  reserveWidthPx?: number | null;
  gapPx?: number;
  marginPx?: number;
  rightLimitPx?: number | null;
}): LegacyLayoutResult | null;

export declare function computeLegacyVerticalTaskbarLayout(params: {
  rebarClientOrigin: { x: number; y: number };
  rebarClientSize: { width: number; height: number };
  taskbarClientOrigin: { x: number; y: number };
  taskListRect?: Rect | null;
  stripLengthPx: number;
  reserveLengthPx?: number | null;
  gapPx?: number;
  marginPx?: number;
  bottomLimitPx?: number | null;
}): LegacyLayoutResult | null;

export declare function selectGap(params: {
  taskbarWidth: number;
  taskbarHeight: number;
  buttons: readonly Pick<ProbeButton, 'x' | 'w' | 'h'>[];
  side: 'left' | 'right';
  minGapCss?: number;
}): GapRange | null;

export declare function clampWindowWidth(params: {
  contentWidthCss: number;
  gapWidthCss: number;
  minWindowCss?: number;
  windowPaddingCss?: number;
  dockMarginCss?: number;
}): number;

export declare function buildProbeScript(taskbarHwnd?: number | bigint): string;
export declare function encodePowerShellCommand(script: string): string;
export declare function parseProbeOutput(stdout: string): ProbeResult | null;
export declare function probeTaskbar(options?: {
  taskbarHwnd?: number | bigint;
  timeoutMs?: number;
}): Promise<ProbeResult | null>;

export declare function getNativeHwnd(win: unknown): bigint | null;
export declare function findTaskbar(): bigint | null;
export declare function findTrayNotify(trayHwnd: bigint | number | null): bigint | null;
export declare function findTaskbarContainer(trayHwnd: bigint | number | null): bigint | null;
export declare function findTaskList(containerHwnd: bigint | number | null): bigint | null;
export declare function listTaskbars(): bigint[];
export declare function getWindowMonitor(hwnd: bigint | number | null): bigint | null;
export declare function getMonitorRect(hwnd: bigint | number | null): Rect | null;
export declare function getTaskbarMetrics(trayHwnd: bigint | number | null): TaskbarMetrics | null;
export declare function getWindowRect(hwnd: bigint | number | null): Rect | null;
export declare function getForegroundWindow(): bigint | null;
export declare function getClassName(hwnd: bigint | number | null): string;
export declare function isWindowVisible(hwnd: bigint | number | null): boolean;
export declare function hideWindow(hwnd: bigint | number | null): boolean;
export declare function getWindowParent(hwnd: bigint | number | null): bigint | null;
export declare function getWindowAncestor(hwnd: bigint | number | null): bigint | null;
export declare function embedWindow(hwnd: bigint | number | null, trayHwnd: bigint | number | null): boolean;
export declare function getWindowStyleInfo(hwnd: bigint | number | null): WindowStyleInfo | null;
export declare function setWindowBounds(hwnd: bigint | number | null, bounds: Bounds): boolean;
export declare function moveWindow(hwnd: bigint | number | null, bounds: Bounds): boolean;
export declare function assertTopChild(hwnd: bigint | number | null): boolean;
export declare function isWindow(hwnd: bigint | number | null): boolean;
export declare function getTaskbarWindowsFingerprint(): string | null;
export declare function isFullscreenRect(rect: Rect | null, bounds: Bounds | null): boolean;
export declare function isFullscreenForeground(params?: {
  trayHwnd?: bigint | number | null;
  ownHwnd?: bigint | number | null;
  bounds?: Bounds | null;
}): boolean;
export declare function readSystemUsesLightTheme(): boolean | null;
export declare function readTaskbarAlignment(): number | null;
export declare function getOsBuild(): number;
export declare function isLegacyBuild(): boolean;
export declare function getNativeInitError(): string | null;
export declare function isRightAltOrCtrlDown(): boolean;
