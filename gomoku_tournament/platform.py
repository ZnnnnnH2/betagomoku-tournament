"""在独立、持久的浏览器配置中调用 BetaGomoku 的同源执行接口。"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import time
from typing import Any

from .core import PlayerFault, ServiceUnavailable

BASE_URL = "http://gomoku.ruc.rvalue.moe/"
STATUS_NAMES = ["Unknown", "OK", "Time Limit Exceeded", "Memory Limit Exceeded", "Runtime Error", "Cancelled", "Output Limit Exceeded"]
BROWSER_EXECUTABLES = {
    "chrome": ("com.google.Chrome", Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    "edge": ("com.microsoft.edgemac", Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")),
}


def default_browser_bundle() -> str:
    """读取 macOS 的 HTTP 默认处理程序，不依赖系统默认的可执行文件名。"""
    command = ["defaults", "read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    match = re.search(r'LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = http;', result.stdout)
    if not match:
        raise RuntimeError("无法读取 macOS 的 HTTP 默认浏览器。")
    return match.group(1)


def browser_executable(browser: str) -> Path:
    if browser == "default":
        bundle = default_browser_bundle()
        match = next((item for item in BROWSER_EXECUTABLES.values() if item[0] == bundle), None)
        if match is None:
            raise RuntimeError(f"系统默认浏览器是 {bundle}，但 Playwright 只能控制 Chrome 或 Edge。")
        executable = match[1]
    else:
        try:
            executable = BROWSER_EXECUTABLES[browser][1]
        except KeyError as error:
            raise ValueError(f"不支持的浏览器选项：{browser}") from error
    if not executable.exists():
        raise RuntimeError(f"未找到浏览器可执行文件：{executable}")
    return executable


class PlatformClient:
    def __init__(self, profile_dir: Path, base_url: str = BASE_URL, retries: int = 4, browser: str = "default"):
        self.profile_dir = profile_dir
        self.base_url = base_url
        self.retries = retries
        self.browser = browser
        self._playwright: Any = None
        self.context: Any = None
        self.page: Any = None

    def __enter__(self) -> "PlatformClient":
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as error:
            raise RuntimeError("缺少 Playwright。请先运行：.venv/bin/python -m pip install -r requirements.txt") from error
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = sync_playwright().start()
        executable = browser_executable(self.browser)
        options: dict[str, Any] = {"user_data_dir": str(self.profile_dir), "headless": False, "executable_path": str(executable)}
        self.context = self._playwright.chromium.launch_persistent_context(**options)
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        self.page.goto(self.base_url, wait_until="domcontentloaded")
        return self

    def __exit__(self, *_: Any) -> None:
        if self.context:
            self.context.close()
        if self._playwright:
            self._playwright.stop()

    def logged_in(self) -> bool:
        return self.page.locator("#player0").count() == 1

    def wait_for_login(self) -> None:
        if self.logged_in():
            return
        print("已打开登录页。请在弹出的浏览器中完成微人大认证，然后回到终端按 Enter。")
        input()
        self.page.goto(self.base_url, wait_until="domcontentloaded")
        if not self.logged_in():
            raise RuntimeError("尚未检测到登录状态；请确认已回到 BetaGomoku 首页。")

    def available_players(self) -> set[str]:
        return set(self.page.locator("#player0 option").evaluate_all("options => options.map(option => option.value).filter(Boolean)"))

    def move_for(self, uid: str, board_input: str) -> tuple[int, int]:
        payload = {"uid": uid, "input": board_input}
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                reply = self.page.evaluate(
                    """async payload => {
                        try {
                          const response = await fetch('/api/exec', {
                            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
                          });
                          let body;
                          try { body = await response.json(); } catch (_) { return {http: response.status, parseError: true}; }
                          return {http: response.status, body};
                        } catch (error) { return {transportError: String(error)}; }
                    }""",
                    payload,
                )
                if reply.get("transportError") or reply.get("parseError") or reply.get("http") != 200:
                    raise ServiceUnavailable(reply.get("transportError") or f"HTTP {reply.get('http')}")
                result = reply.get("body", {}).get("result", {})
                status = result.get("status")
                if status != 1:
                    label = STATUS_NAMES[status] if isinstance(status, int) and 0 <= status < len(STATUS_NAMES) else f"执行状态 {status}"
                    raise PlayerFault(label)
                output = str(reply["body"].get("output", "")).strip().split()
                if len(output) != 2:
                    raise PlayerFault("Invalid output")
                try:
                    return int(output[0]), int(output[1])
                except ValueError as error:
                    raise PlayerFault("Invalid output") from error
            except PlayerFault:
                raise
            except ServiceUnavailable as error:
                last_error = error
            except Exception as error:  # Playwright navigation/transport failure
                last_error = ServiceUnavailable(str(error))
            if attempt < self.retries:
                time.sleep(2 ** (attempt - 1))
        raise ServiceUnavailable(f"平台连续 {self.retries} 次请求失败：{last_error}")
