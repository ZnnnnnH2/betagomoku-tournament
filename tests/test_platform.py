from __future__ import annotations

import unittest

from gomoku_tournament.platform import BROWSER_EXECUTABLES, browser_executable, default_browser_bundle


class PlatformConfigurationTests(unittest.TestCase):
    def test_system_default_browser_is_a_supported_chromium_browser(self) -> None:
        bundle = default_browser_bundle()
        self.assertIn(bundle, {item[0] for item in BROWSER_EXECUTABLES.values()})
        executable = browser_executable("default")
        self.assertTrue(executable.exists())
        self.assertTrue(any(str(candidate) == str(executable) for _bundle, candidate in BROWSER_EXECUTABLES.values()))


if __name__ == "__main__":
    unittest.main()
